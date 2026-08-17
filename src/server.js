require('dotenv').config();
const express = require('express');
const PQueue = require('p-queue').default;

const { getBrowser, closeBrowser, isBrowserLaunched, killStrayChromiumProcesses } = require('./browser');
const { searchGoogleMapsUrlsOnly, getPlaceDetails } = require('./mapsScraper');
const { findEmail } = require('./emailFinder');
const { randomDelay } = require('./utils');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || '10', 10);
const MAX_LIMIT = parseInt(process.env.MAX_LIMIT || '25', 10);
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '1', 10);
// Hard ceiling on how long a single scrape job is allowed to run. If it's
// exceeded, we force-kill the browser (freeing all its memory immediately)
// and return an error instead of leaving the request hanging until Render's
// own proxy times out with no cleanup. Keep this comfortably BELOW whatever
// timeout you set on the n8n HTTP Request node calling this service.
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '100000', 10);

if (!API_KEY || API_KEY === 'change_me_to_a_long_random_string') {
  console.warn(
    '[WARN] API_KEY is not set (or still the placeholder). ' +
    'Anyone with your Render URL will be able to run scrapes. Set a real API_KEY in your env.'
  );
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Only one (or a couple) scrape job runs at a time — Maps scraping is
// resource-heavy and hammering it concurrently is also the fastest way to
// get your IP flagged. On a 512MB instance, keep this at 1.
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Job lifecycle wrapper — THE core reliability fix.
//
// Every job:
//   1. gets a browser (fresh-launched or reused-if-healthy, see browser.js)
//   2. runs against it
//   3. the browser is ALWAYS closed afterwards, success or failure
//
// Step 3 is new. The original code kept one browser alive forever across all
// requests. On 512MB that browser eventually gets OOM-killed or its renderer
// crashes, and every request after that hangs against a dead reference —
// which is exactly the "worked once, then never again" failure being
// reported. Paying ~1-2s to relaunch Chromium per request is a small price
// for a service that never gets permanently wedged.
//
// A timeout race is layered on top so a job that hangs mid-scrape (slow
// network, Google serving a captcha page, etc.) can't block the queue
// forever — it gets killed and the browser torn down with it.
// ---------------------------------------------------------------------------
async function runJob(taskFn) {
  return queue.add(async () => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Job exceeded ${JOB_TIMEOUT_MS}ms timeout`));
      }, JOB_TIMEOUT_MS);
    });

    let result;
    let error;
    try {
      const browser = await getBrowser();
      result = await Promise.race([taskFn(browser), timeout]);
    } catch (err) {
      error = err;
    } finally {
      clearTimeout(timer);
      // Deliberately NOT awaited. closeBrowser() has its own internal
      // hard timeout + force-kill (see browser.js), but even so, the HTTP
      // response to n8n must never be held hostage by cleanup — the job
      // outcome is already known at this point, so we respond immediately
      // and let cleanup finish in the background.
      closeBrowser().catch((err) => console.error('[closeBrowser] cleanup error:', err));

      // Node/V8 normally reclaims freed memory back to the OS lazily, on
      // its own schedule — fine for most apps, but on a 512MB box every MB
      // matters and we'd rather reclaim it the instant a job's data (page
      // content strings, DOM snapshots, etc.) goes out of scope instead of
      // waiting. Requires --expose-gc (set in the Dockerfile); harmless
      // no-op otherwise.
      if (typeof global.gc === 'function') {
        global.gc();
      }
    }

    if (error) throw error;
    return result;
  });
}

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    queued: queue.size,
    running: queue.pending,
    browserActive: isBrowserLaunched(),
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    },
  });
});

/**
 * POST /scrape-leads
 * body: { "query": "dentist in bay area", "limit": 20, "excludeUrls": ["https://www.google.com/maps/place/..."] }
 *
 * LIGHTWEIGHT BY DESIGN: this endpoint only scrolls the results feed and
 * collects { name, mapsUrl } for each business — it does NOT open detail
 * panes, does NOT read website/phone/address/rating, and does NOT look up
 * emails. That's intentional: it keeps this phase fast and cheap on a
 * 512MB instance. Feed each returned `mapsUrl` into POST /enrich-lead
 * (one call per lead, or looped from n8n) to get the full details + email.
 *
 * `excludeUrls` — mapsUrl values already in your sheet for this domain/city/
 * country combo (pulled and filtered on the n8n side beforehand). Matching
 * is by the stable Place ID inside each URL, so exact string differences
 * (tracking params etc.) don't break it.
 *
 * Returns an array of: { name, mapsUrl }
 */
app.post('/scrape-leads', requireApiKey, async (req, res) => {
  const { query, limit, excludeUrls = [] } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: '"query" (string) is required, e.g. "dentist in bay area"' });
  }
  if (!Array.isArray(excludeUrls)) {
    return res.status(400).json({ error: '"excludeUrls" must be an array of strings' });
  }

  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const result = await runJob((browser) =>
      searchGoogleMapsUrlsOnly(browser, query, cappedLimit, excludeUrls)
    );
    res.json({ query, count: result.length, results: result });
  } catch (err) {
    console.error('[scrape-leads] failed:', err);
    res.status(500).json({ error: 'Scrape failed', detail: String(err.message || err) });
  }
});

/**
 * POST /find-email
 * body: { "website": "https://example-business.com" }
 *
 * Standalone email lookup — doesn't touch Google Maps at all. Useful for
 * running email enrichment on websites you already have from any source
 * (a previous scrape, a CSV import, another n8n branch, etc.) without
 * re-running a full Maps search.
 */
app.post('/find-email', requireApiKey, async (req, res) => {
  const { website } = req.body || {};

  if (!website || typeof website !== 'string') {
    return res.status(400).json({ error: '"website" (string, full URL) is required' });
  }

  try {
    const email = await runJob((browser) => findEmail(browser, website));
    res.json({ website, email });
  } catch (err) {
    console.error('[find-email] failed:', err);
    res.status(500).json({ error: 'Lookup failed', detail: String(err.message || err) });
  }
});

// Domains that are Google's own infrastructure/UI chrome, not an actual
// external business/result link. Used to filter fallback link scans so
// "grab everything that looks like a site" doesn't return Google's own
// nav/policy/asset links.
const GOOGLE_OWNED_PATTERN = /(^https?:\/\/)?([a-z0-9-]+\.)*(google\.[a-z.]+|googleapis\.com|gstatic\.com|googleusercontent\.com|ggpht\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|schema\.org|w3\.org|googleadservices\.com|withgoogle\.com|goo\.gl)(\/|$)/i;

// Scans a page already loaded in `page` for every plausible external link —
// both real <a href> tags and quoted URLs sitting inside inline JS/JSON
// blobs (which is where Maps/Search often hide data). Returns deduped root
// domains, Google's own domains filtered out.
async function extractExternalLinksFromPage(page) {
  const anchorHrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)
  );
  const html = await page.content();
  const quotedUrls = (html.match(/"(https?:\/\/[^"\\]+)"/g) || []).map((s) =>
    s.slice(1, -1).replace(/\\\//g, '/')
  );

  const all = [...anchorHrefs, ...quotedUrls]
    .filter((u) => /^https?:\/\//.test(u))
    .filter((u) => !GOOGLE_OWNED_PATTERN.test(u))
    .filter((u) => !/\.(png|jpe?g|gif|svg|css|js|woff2?|ico)(\?|$)/i.test(u));

  const rootRegex = /^https?:\/\/[^\/]+/;
  const domains = all.map((u) => (u.match(rootRegex) || [u])[0]);
  return [...new Set(domains)];
}

/**
 * POST /extract-xpath
 * body: {
 *   "url": "https://...",
 *   "xpath": "/html/body/div[1].../a",
 *   "fetchTarget": true   // optional, default false — if a target link is
 *                         // found (via xpath or fallback), also navigate to
 *                         // it and return its page content
 * }
 *
 * Tries the exact XPath first. If it doesn't match, or matches something
 * with no usable link, falls back to scanning the whole rendered page for
 * external links/URLs and returns those as `candidates` — so a DOM reshuffle
 * degrades gracefully instead of just returning nothing.
 */
app.post('/extract-xpath', requireApiKey, async (req, res) => {
  const { url, xpath, fetchTarget = false } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '"url" (string) is required' });
  }
  if (!xpath || typeof xpath !== 'string') {
    return res.status(400).json({ error: '"xpath" (string) is required' });
  }

  try {
    const result = await runJob((browser) => runExtractXPathJob(browser, url, xpath, fetchTarget));
    res.json(result);
  } catch (err) {
    console.error('[extract-xpath] failed:', err);
    res.status(500).json({ error: 'Extraction failed', detail: String(err.message || err) });
  }
});

async function runExtractXPathJob(browser, url, xpath, fetchTarget) {
  const { newStealthPage } = require('./browser');
  const page = await newStealthPage(browser);
  let matched = null;
  let candidates = [];
  let usedFallback = false;

  try {
    // 'domcontentloaded' rather than 'networkidle2' — same reasoning as
    // mapsScraper.js: many modern sites keep background connections alive
    // (analytics, chat widgets, ads) and never truly go network-idle,
    // which would otherwise stall this for the full timeout regardless of
    // how fast the page actually rendered.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(500, 1200);

    matched = await page.evaluate((xp) => {
      const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = result.singleNodeValue;
      if (!node) return null;
      const linkEl = node.tagName === 'A' ? node : node.querySelector('a[href]');
      return {
        tagName: node.tagName || null,
        text: (node.textContent || '').trim(),
        href: linkEl ? linkEl.href : null,
      };
    }, xpath);

    // XPath missed entirely, or hit something with no link in it — fall
    // back to a broad scan instead of giving up.
    if (!matched || !matched.href) {
      candidates = await extractExternalLinksFromPage(page);
      usedFallback = true;
    }
  } finally {
    await page.close().catch(() => {});
  }

  const bestHref = matched?.href || candidates[0] || null;

  let target = null;
  if (fetchTarget && bestHref) {
    const targetPage = await newStealthPage(browser);
    try {
      await targetPage.goto(bestHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await randomDelay(300, 700);
      const title = await targetPage.title();
      const html = await targetPage.content();
      target = { url: bestHref, title, htmlLength: html.length, html };
    } catch (err) {
      target = { url: bestHref, error: String(err.message || err) };
    } finally {
      await targetPage.close().catch(() => {});
    }
  }

  return {
    url,
    xpath,
    found: !!matched,
    matched,
    usedFallback,
    candidates: usedFallback ? candidates : undefined,
    bestGuessUrl: bestHref,
    target,
  };
}

/**
 * POST /enrich-lead
 * body: { "mapsUrl": "https://www.google.com/maps/place/..." }
 *
 * The "fill the gaps" step for leads that came back from /scrape-leads with
 * a missing email. Visits the business's own Maps place page directly and:
 *   1. Checks the Maps page itself for an email (mailto: link, or plain text
 *      email in the page — some listings surface one this way).
 *   2. Confirms/re-reads the website field.
 *   3. If no email was found on the Maps page but a website exists, crawls
 *      that website (same logic as /find-email) as a fallback.
 * Returns whichever combination was found, plus where the email came from.
 */
app.post('/enrich-lead', requireApiKey, async (req, res) => {
  const { mapsUrl } = req.body || {};

  if (!mapsUrl || typeof mapsUrl !== 'string') {
    return res.status(400).json({ error: '"mapsUrl" (string) is required — the individual place URL, not a search results URL' });
  }

  try {
    const result = await runJob((browser) => runEnrichLeadJob(browser, mapsUrl));
    res.json(result);
  } catch (err) {
    console.error('[enrich-lead] failed:', err);
    res.status(500).json({ error: 'Enrichment failed', detail: String(err.message || err) });
  }
});

async function runEnrichLeadJob(browser, mapsUrl) {
  const details = await getPlaceDetails(browser, mapsUrl);

  let email = details.emailOnPage || null;
  let emailSource = email ? 'maps_page' : null;

  if (!email && details.website) {
    try {
      email = await findEmail(browser, details.website);
      if (email) emailSource = 'website';
    } catch (_) {
      email = null;
    }
  }

  return {
    mapsUrl,
    name: details.name,
    website: details.website,
    phone: details.phone,
    address: details.address,
    rating: details.rating,
    category: details.category,
    email,
    emailSource, // 'maps_page' | 'website' | null
  };
}

// Malformed JSON bodies etc. — respond cleanly instead of an unhandled 500.
app.use((err, req, res, next) => {
  console.error('[express error]', err);
  res.status(400).json({ error: 'Bad request', detail: String(err.message || err) });
});

const server = app.listen(PORT, () => {
  console.log(`maps-scraper API listening on port ${PORT}`);
  // Best-effort cleanup of any Chromium processes left running from before
  // this process started (e.g. a live env-var change rather than a fresh
  // container). Harmless no-op if there are none. A genuine fresh Render
  // deploy gets a brand new container anyway, so this mostly matters right
  // after upgrading an already-running service to this fix.
  killStrayChromiumProcesses().catch(() => {});
});

// Give in-flight scrapes a moment to finish before Render's SIGTERM (on
// deploy/restart) hard-kills the process.
async function gracefulShutdown() {
  console.log('Shutting down — closing browser...');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Last-resort safety net: log and exit rather than leaving a half-broken
// process running that Render's health check will eventually flag anyway.
// Render restarts the service automatically on crash.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
