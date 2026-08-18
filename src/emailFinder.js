const { newStealthPage } = require('./browser');
const { randomDelay } = require('./utils');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Domains/patterns that technically match the email regex but are noise:
// analytics pixels, placeholder addresses, image filenames misread as
// emails, third-party widget accounts, etc.
const BLOCKLIST_PATTERNS = [
  /sentry\.io/i,
  /wixpress\.com/i,
  /example\.com/i,
  /godaddy\.com/i,
  /schema\.org/i,
  /\.(png|jpe?g|gif|svg|webp)$/i,
  /^(no-?reply|donotreply)@/i,
];

// Trimmed from 6 candidate paths to 4 — '/contactus' and '/about-us' were
// largely redundant with '/contact-us' and '/about', and every extra path
// is extra worst-case time (see FIND_EMAIL_BUDGET_MS below).
const CANDIDATE_PATHS = ['', '/contact', '/contact-us', '/about'];

// Per-path navigation timeout. Lowered from 12000ms: domcontentloaded is
// all we actually need (we only read HTML/mailto links, nothing that
// requires the page to fully render), so a genuinely slow/unresponsive
// site should fail fast rather than eat a long timeout.
const PER_PATH_TIMEOUT_MS = 8000;

// Hard ceiling on TOTAL time findEmail is allowed to spend across ALL
// candidate paths combined. Without this, a per-path timeout alone doesn't
// bound the worst case — 4 paths x 8s = 32s is fine, but on Render's
// throttled CPU even "fast" operations can run long, and a site that hangs
// (rather than cleanly failing) on every path could still add up. This
// budget is the real guarantee that findEmail can never single-handedly
// blow through JOB_TIMEOUT_MS (100s default): it leaves generous headroom
// for the Maps page load + consent handling that happens before findEmail
// is ever called (see mapsScraper.js).
const FIND_EMAIL_BUDGET_MS = parseInt(process.env.FIND_EMAIL_BUDGET_MS || '35000', 10);

function extractEmailsFromHtml(html) {
  const matches = html.match(EMAIL_REGEX) || [];
  const unique = [...new Set(matches.map((e) => e.trim().toLowerCase()))];
  return unique.filter((email) => !BLOCKLIST_PATTERNS.some((p) => p.test(email)));
}

function scoreEmail(email, domain) {
  // Prefer addresses that live on the business's own domain, and prefer
  // generic role addresses (info@, contact@) over personal-looking ones
  // scraped incidentally from a page footer, since role addresses are more
  // likely to be actively monitored for a cold outreach use case.
  let score = 0;
  if (domain && email.endsWith(`@${domain}`)) score += 10;
  if (/^(info|contact|hello|sales|office)@/.test(email)) score += 5;
  return score;
}

/**
 * Visit a business website (and a couple of likely contact-ish pages) and
 * try to find the best-guess contact email.
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} websiteUrl
 * @returns {Promise<string|null>}
 */
async function findEmail(browser, websiteUrl) {
  if (!websiteUrl) return null;

  let baseUrl;
  try {
    baseUrl = new URL(websiteUrl);
  } catch (_) {
    return null;
  }
  const domain = baseUrl.hostname.replace(/^www\./, '');

  const page = await newStealthPage(browser);
  const foundEmails = new Set();
  const startedAt = Date.now();

  try {
    for (const path of CANDIDATE_PATHS) {
      if (Date.now() - startedAt >= FIND_EMAIL_BUDGET_MS) {
        break; // over budget — stop trying further paths, return whatever we have
      }

      const targetUrl = path ? `${baseUrl.origin}${path}` : baseUrl.origin;
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PER_PATH_TIMEOUT_MS });
        await randomDelay(300, 700);

        const html = await page.content();
        extractEmailsFromHtml(html).forEach((e) => foundEmails.add(e));

        // mailto: links are the highest-confidence signal — grab them directly.
        const mailtoEmails = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
          return anchors.map((a) =>
            a.getAttribute('href').replace('mailto:', '').split('?')[0].trim().toLowerCase()
          );
        });
        mailtoEmails.forEach((e) => {
          if (e && !BLOCKLIST_PATTERNS.some((p) => p.test(e))) foundEmails.add(e);
        });
      } catch (_) {
        continue; // page didn't load / path 404s — try the next candidate path
      }

      // Stop early once we have something rather than crawling every path blind.
      if (foundEmails.size > 0) break;
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (foundEmails.size === 0) return null;

  const ranked = [...foundEmails].sort((a, b) => scoreEmail(b, domain) - scoreEmail(a, domain));
  return ranked[0];
}

module.exports = { findEmail, extractEmailsFromHtml, BLOCKLIST_PATTERNS };
