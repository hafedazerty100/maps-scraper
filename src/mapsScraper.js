const { newStealthPage } = require('./browser');
const { randomDelay, humanClick, scrollResultsFeed } = require('./utils');
const { extractEmailsFromHtml } = require('./emailFinder');

const FEED_SELECTOR = 'div[role="feed"]';
const RESULT_LINK_SELECTOR = 'a.hfpxzc'; // anchor wrapping each result card

// Google shows a cookie/consent wall on first visit in many regions.
// Try a handful of button texts across locales; ignore failure if absent.
async function acceptConsentIfPresent(page) {
  const consentTexts = [
    'Accept all', 'I agree', 'Tout accepter', 'J\'accepte',
    'Accepter tout', 'Reject all', 'Refuser tout',
  ];
  try {
    // Single evaluate() call instead of one round-trip per button — the old
    // version pulled each button handle back to Node and called
    // page.evaluate() per button, which is dozens of IPC round-trips on a
    // page that can have 40+ buttons. This does the whole scan in-page and
    // only crosses the bridge once.
    const clicked = await page.evaluate((texts) => {
      const els = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const match = els.find((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return texts.some((needle) => t.includes(needle.toLowerCase()));
      });
      if (match) {
        match.click();
        return true;
      }
      return false;
    }, consentTexts);

    if (clicked) {
      await randomDelay(400, 900);
    }
  } catch (_) {
    // consent wall not present or already dismissed — fine
  }
}

// Pulls website + phone out of the detail pane that opens after clicking a result.
async function extractDetailFields(page) {
  return page.evaluate(() => {
    const website = document.querySelector('a[data-item-id="authority"]');
    const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
    const addressBtn = document.querySelector('button[data-item-id="address"]');
    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
    const categoryEl = document.querySelector('button.DkEaL');

    return {
      website: website ? website.href : null,
      phone: phoneBtn ? phoneBtn.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '') || null : null,
      address: addressBtn ? addressBtn.getAttribute('aria-label')?.replace(/^Address:\s*/i, '') || null : null,
      rating: ratingEl ? ratingEl.textContent.trim() : null,
      category: categoryEl ? categoryEl.textContent.trim() : null,
    };
  });
}

// Google Maps embeds a stable Place ID inside listing URLs (the "!19sChIJ..."
// segment), which stays constant for a given business even as unrelated
// tracking params (authuser, hl, rclk, viewport coords) change between
// requests. Extracting that instead of comparing raw URLs means dedup still
// works even when the URL string itself isn't byte-identical.
function extractPlaceKey(mapsUrl) {
  if (!mapsUrl) return null;
  let m = mapsUrl.match(/!19s([^!?]+)/); // Place ID, most stable
  if (m) return decodeURIComponent(m[1]);
  m = mapsUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i); // CID-based fallback
  if (m) return m[1].toLowerCase();
  return mapsUrl.split('?')[0].replace(/\/$/, ''); // last resort: bare path
}

/**
 * Search Google Maps for a query and return up to `limit` business listings
 * that are NOT already in `excludeUrls` — so repeated runs against the same
 * query surface fresh businesses instead of the same top results every time.
 * Matching is by Place ID extracted from each mapsUrl, not exact string
 * comparison, so harmless tracking-param differences don't break dedup.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} query e.g. "dentist in bay area"
 * @param {number} limit
 * @param {string[]} excludeUrls mapsUrl values already scraped previously
 * @returns {Promise<Array<{name, mapsUrl, website, phone, address, rating, category, emailOnPage}>>}
 */
async function searchGoogleMaps(browser, query, limit, excludeUrls = []) {
  const excludeSet = new Set(excludeUrls.map(extractPlaceKey).filter(Boolean));
  const page = await newStealthPage(browser);
  const results = [];

  try {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
    // NOT 'networkidle2': Google Maps is a heavy SPA that keeps background
    // connections alive continuously (live traffic, tile loading,
    // telemetry) — it can genuinely never go network-idle, so that wait
    // condition can hang for the full timeout on every request regardless
    // of how fast the page actually rendered. 'domcontentloaded' fires as
    // soon as the initial HTML/JS is parsed; the explicit
    // waitForSelector(FEED_SELECTOR) right after is the real signal we
    // actually need (the results feed has hydrated), and is both faster
    // and far more reliable than waiting on network activity.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsentIfPresent(page);
    await randomDelay(600, 1300);

    await page.waitForSelector(FEED_SELECTOR, { timeout: 30000 }).catch(() => {});

    let processedCount = 0;
    // Capped rather than unbounded (old: limit * 8, up to 100+ for big
    // limits). Scanning fewer cards means less DOM growth and fewer detail
    // panes opened per job, which matters a lot at 512MB.
    const MAX_SCAN = Math.min(Math.max(limit * 5, 40), 80);

    while (results.length < limit && processedCount < MAX_SCAN) {
      await scrollResultsFeed(page, FEED_SELECTOR, { desiredCount: processedCount + 10 });

      const cardHandles = await page.$$(RESULT_LINK_SELECTOR);
      if (cardHandles.length <= processedCount) {
        break; // no new cards loaded — end of this query's results
      }

      for (let i = processedCount; i < cardHandles.length && results.length < limit; i++) {
        const handle = cardHandles[i];
        try {
          // Grab both name and href straight off the card BEFORE clicking,
          // so an excluded business costs nothing beyond reading its href.
          const mapsUrl = await page.evaluate((el) => el.href, handle);
          const placeKey = extractPlaceKey(mapsUrl);

          if (placeKey && excludeSet.has(placeKey)) {
            continue; // already in the sheet — skip without opening its detail pane
          }

          const name = await page.evaluate((el) => el.getAttribute('aria-label'), handle);
          if (!name) continue;

          await humanClick(page, handle);
          await page.waitForSelector(
            'a[data-item-id="authority"], button[data-item-id^="phone:tel:"]',
            { timeout: 7000 }
          ).catch(() => {});
          await randomDelay(400, 1000);

          const details = await extractDetailFields(page);

          const mailtoEmails = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
            return anchors.map((a) => a.getAttribute('href').replace('mailto:', '').split('?')[0].trim().toLowerCase());
          });
          const html = await page.content();
          const scannedEmails = extractEmailsFromHtml(html);
          const emailOnPage = mailtoEmails[0] || scannedEmails[0] || null;

          results.push({
            name: name.trim(),
            mapsUrl,
            website: details.website,
            phone: details.phone,
            address: details.address,
            rating: details.rating,
            category: details.category,
            emailOnPage,
          });

          await randomDelay(300, 700);
        } catch (err) {
          continue;
        }
      }

      processedCount = cardHandles.length;
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

/**
 * Lightweight variant of searchGoogleMaps: scrolls the results feed and
 * collects only { name, mapsUrl } straight off each card — it never clicks
 * into a detail pane and never touches a business's own website. This is
 * the fast, low-memory phase meant to run inside /scrape-leads. Pair it
 * with /enrich-lead (one call per mapsUrl) to fill in website/phone/
 * address/email afterwards — splitting the work this way means a single
 * enrichment failure only costs you one lead, not the whole batch, and the
 * search phase itself finishes in a fraction of the time since it's not
 * opening N detail panes or crawling N websites.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} query
 * @param {number} limit
 * @param {string[]} excludeUrls
 * @returns {Promise<Array<{name, mapsUrl}>>}
 */
async function searchGoogleMapsUrlsOnly(browser, query, limit, excludeUrls = []) {
  const excludeSet = new Set(excludeUrls.map(extractPlaceKey).filter(Boolean));
  const page = await newStealthPage(browser);
  const results = [];

  try {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
    // See the identical comment in searchGoogleMaps() above — Maps never
    // reliably reaches 'networkidle2', so use 'domcontentloaded' + an
    // explicit feed-selector wait instead.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsentIfPresent(page);
    await randomDelay(600, 1300);

    await page.waitForSelector(FEED_SELECTOR, { timeout: 30000 }).catch(() => {});

    let processedCount = 0;
    const MAX_SCAN = Math.min(Math.max(limit * 5, 40), 80);

    while (results.length < limit && processedCount < MAX_SCAN) {
      await scrollResultsFeed(page, FEED_SELECTOR, { desiredCount: processedCount + 10 });

      const cardHandles = await page.$$(RESULT_LINK_SELECTOR);
      if (cardHandles.length <= processedCount) {
        break; // no new cards loaded — end of this query's results
      }

      for (let i = processedCount; i < cardHandles.length && results.length < limit; i++) {
        const handle = cardHandles[i];
        try {
          // No click, no detail pane, no website visit — just read what's
          // already sitting in the card's own anchor tag.
          const mapsUrl = await page.evaluate((el) => el.href, handle);
          const placeKey = extractPlaceKey(mapsUrl);

          if (placeKey && excludeSet.has(placeKey)) {
            continue; // already in the sheet
          }

          const name = await page.evaluate((el) => el.getAttribute('aria-label'), handle);
          if (!name || !mapsUrl) continue;

          results.push({ name: name.trim(), mapsUrl });
        } catch (err) {
          continue;
        }
      }

      processedCount = cardHandles.length;
    }
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

/**
 * Visit a single Google Maps *place* page directly (not a search results
 * page — this is the URL you get per-listing, e.g. from a prior search's
 * `mapsUrl` field) and read everything available straight off it: name,
 * website, phone, address, and — checked directly on this page — any email
 * the business listed (some profiles show a contact email as a custom link
 * or in their "About"/description text, not just a website).
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} mapsUrl
 */
async function getPlaceDetails(browser, mapsUrl) {
  const page = await newStealthPage(browser);

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await acceptConsentIfPresent(page);
    await randomDelay(500, 1200);

    await page.waitForSelector(
      'a[data-item-id="authority"], button[data-item-id^="phone:tel:"], h1',
      { timeout: 10000 }
    ).catch(() => {});

    const name = await page.evaluate(() => {
      const h1 = document.querySelector('h1.DUwDvf, h1');
      return h1 ? h1.textContent.trim() : null;
    });

    const details = await extractDetailFields(page);

    const mailtoEmails = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
      return anchors.map((a) => a.getAttribute('href').replace('mailto:', '').split('?')[0].trim().toLowerCase());
    });

    const html = await page.content();
    const scannedEmails = extractEmailsFromHtml(html);

    const emailOnPage = mailtoEmails[0] || scannedEmails[0] || null;

    return { name, ...details, emailOnPage };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { searchGoogleMaps, searchGoogleMapsUrlsOnly, getPlaceDetails };
