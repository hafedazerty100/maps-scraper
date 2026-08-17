const { exec } = require('child_process');
const util = require('util');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteerCore = require('puppeteer-core');
const { randomUserAgent, randomViewport } = require('./utils');

const execAsync = util.promisify(exec);

puppeteerExtra.use(StealthPlugin());
// puppeteer-extra needs an underlying puppeteer implementation; we hand it
// puppeteer-core since Docker uses the system-installed Chromium (see
// Dockerfile) rather than the bundled one puppeteer normally downloads.
puppeteerExtra.setBrowserFetcher = () => {}; // no-op safeguard, core has no fetcher

// ---------------------------------------------------------------------------
// THE #1 BUG THIS FILE FIXES
// ---------------------------------------------------------------------------
// The old code cached `browserPromise` forever after the first launch. On a
// 512MB / 1 CPU Render instance, Chromium runs right at the edge of the
// memory ceiling. The very first time it gets OOM-killed or the renderer
// crashes (extremely likely under those constraints), the *Node process*
// stays alive but `browserPromise` still resolves to a dead Browser object.
// Every request after that calls `browser.newPage()` on a corpse — it either
// throws immediately or hangs until Puppeteer's internal timeout, which is
// exactly the "keeps failing after taking a long time" symptom being
// reported. Restarting the Render service was the only fix, until the next
// crash.
//
// The fix: verify the cached browser is still alive (`isConnected()`) before
// handing it out, listen for the 'disconnected' event to invalidate the
// cache immediately, and self-heal by relaunching. Combined with server.js
// closing the browser after every job (see server.js), this means a crash
// can never propagate past a single request.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BUG #2 THIS FILE FIXES (found after real-world testing on Render)
// ---------------------------------------------------------------------------
// closeBrowser() below force-kills the browser process if a graceful close
// hangs (common under Render's throttled CPU). Puppeteer spawns Chromium
// detached, as the leader of its OWN process group, specifically so the
// entire tree — browser + any renderer/utility/crashpad child processes it
// forked — can be killed together via the negative-PID group-kill trick.
// The original force-kill only sent SIGKILL to the top-level PID, not the
// group, which orphaned any child processes instead of killing them. Those
// orphans kept running and kept holding memory. Under CPU throttling,
// graceful closes hang often enough that this compounded fast: by the 2nd
// or 3rd request, there wasn't enough RAM left for a brand new Chromium to
// even start, producing exactly the reported error — "Timed out ... while
// waiting for the WS endpoint URL to appear in stdout" (Chromium never
// managed to boot at all, distinct from the mid-scrape crash bug #1 above).
//
// Fixed by (a) killing the whole process group instead of just the leader,
// and (b) a system-wide stray-process sweep as a fallback safety net if
// every launch attempt still fails, in case any zombies pre-date this fix
// or slipped through some other way.
// ---------------------------------------------------------------------------

let browserPromise = null;

const RENDERER_HEAP_MB = parseInt(process.env.RENDERER_HEAP_MB || '256', 10);

function launchArgs({ singleProcess, viewport }) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // /dev/shm is tiny (or absent) on Render containers — use /tmp instead
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-accelerated-2d-canvas',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-translate',
    '--disable-blink-features=AutomationControlled',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update',
    '--password-store=basic',
    '--use-mock-keychain',
    `--window-size=${viewport.width},${viewport.height}`,
    '--lang=en-US,en',
    // No point ever caching anything — every scrape targets a page we will
    // never revisit. `--disk-cache-dir=/dev/null` is a commonly-suggested
    // trick but is flaky on some Chromium builds (it's a device file, not
    // a real directory, and cache-init code doesn't always handle that
    // gracefully — can add overhead or stall). We get the same practical
    // outcome more reliably via a near-zero cache size cap here,
    // page.setCacheEnabled(false) per page, plus deleting the entire
    // throwaway profile directory ourselves after every job (see
    // closeBrowser in this file) — belt-and-suspenders without the risk.
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--disable-application-cache',
    '--disable-offline-load-stale-cache',
    // Caps the *renderer's* V8 heap. Doesn't cap total Chromium RSS (there's
    // no flag that does), but it stops a heavy Maps page's JS heap from
    // ballooning unchecked, which is the single biggest memory spike we see.
    `--js-flags=--max-old-space-size=${RENDERER_HEAP_MB}`,
  ];

  if (singleProcess) {
    // Merges the browser + renderer into one OS process instead of Chromium's
    // normal multi-process model. This is the single biggest memory win
    // available (typically saves 100-150MB) and is safe here because
    // MAX_CONCURRENCY is 1 and this codebase never has more than one page
    // open at a time per job. Not officially "supported" by the Chromium
    // team for all sites, so if you see mysterious page crashes, set
    // CHROME_SINGLE_PROCESS=false in your env — getBrowser() below will also
    // auto-retry without it if the launch itself fails.
    args.push('--single-process', '--no-zygote');
  }

  if (process.env.PROXY_SERVER) {
    args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
  }

  return args;
}

async function launchOnce(singleProcess, viewport, userDataDir) {
  return puppeteerExtra.launch({
    headless: process.env.HEADLESS !== 'false' ? 'new' : false,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: launchArgs({ singleProcess, viewport }),
    protocolTimeout: 60000,
    userDataDir,
  });
}

// Best-effort, container-wide cleanup of any leftover chromium processes.
// Safe to call even if none exist — `pkill` returns a non-zero exit code
// when nothing matches, which we deliberately ignore.
async function killStrayChromiumProcesses() {
  try {
    await execAsync("pkill -9 -f chromium || true");
  } catch (_) {
    // best-effort only
  }
}

// We pass Chromium its own EXPLICIT, throwaway profile directory instead of
// letting Puppeteer generate one internally. Puppeteer only auto-deletes a
// profile directory it created itself — once you pass your own path (as we
// do here), cleanup is entirely on us. We do that ourselves in closeBrowser
// below, unconditionally, whether the browser closed gracefully or had to
// be force-killed — guaranteeing nothing from a visited site (cache,
// cookies, local storage, service workers) ever survives past the request
// that visited it, which matches the fact that we never revisit a site.
let currentUserDataDir = null;

async function attemptLaunch(singleProcess, viewport) {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mapsscraper-chromium-'));
  try {
    const browser = await launchOnce(singleProcess, viewport, userDataDir);
    return { browser, userDataDir };
  } catch (err) {
    // This attempt's profile dir was never used by a running browser —
    // clean it up immediately rather than leaving it for later.
    fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function launchBrowser() {
  const wantSingleProcess = process.env.CHROME_SINGLE_PROCESS !== 'false';
  const viewport = randomViewport();

  const attempts = [() => attemptLaunch(wantSingleProcess, viewport)];
  if (wantSingleProcess) {
    attempts.push(() => attemptLaunch(false, viewport));
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const { browser, userDataDir } = await attempt();
      currentUserDataDir = userDataDir;
      return browser;
    } catch (err) {
      lastErr = err;
      console.warn('[browser] launch attempt failed:', err.message);
    }
  }

  // Every normal attempt failed. On a memory-constrained box the most
  // common cause is stray Chromium processes (orphaned by a previous forced
  // kill — see the closeBrowser fix above) eating enough RAM that a brand
  // new Chromium can't even start up in time. Sweep and retry once more
  // before giving up for good.
  console.warn('[browser] all launch attempts failed — sweeping stray chromium processes and retrying once');
  await killStrayChromiumProcesses();
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    const { browser, userDataDir } = await attemptLaunch(false, viewport);
    currentUserDataDir = userDataDir;
    return browser;
  } catch (err) {
    throw new Error(
      `Chromium failed to launch even after a cleanup sweep (last error: ${err.message}). ` +
      `Original error: ${lastErr ? lastErr.message : 'n/a'}`
    );
  }
}

/**
 * Returns a live, connected Browser instance. Launches one if none is
 * cached, or if the cached one has died (crash, OOM-kill, manual close).
 * This is what makes the service self-healing instead of permanently
 * wedged after the first crash.
 */
async function getBrowser() {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing && existing.isConnected()) {
        return existing;
      }
    } catch (_) {
      // fall through and relaunch
    }
    browserPromise = null;
  }

  browserPromise = launchBrowser().then((browser) => {
    // Safety net: if Chromium dies mid-job (OOM kill, crash), immediately
    // invalidate the cache so the *next* request launches fresh instead of
    // reusing a corpse.
    browser.once('disconnected', () => {
      if (browserPromise && browserPromise.then) {
        browserPromise = null;
      }
    });
    return browser;
  });

  return browserPromise;
}

// Every new page gets a randomized fingerprint (UA + viewport + a couple of
// header tweaks) instead of Puppeteer's identical defaults on every request.
async function newStealthPage(browser) {
  const page = await browser.newPage();
  const ua = randomUserAgent();
  const viewport = randomViewport();

  await page.setUserAgent(ua);
  await page.setViewport(viewport);
  await page.setDefaultNavigationTimeout(45000);
  await page.setDefaultTimeout(20000);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,fr;q=0.6',
  });
  // Belt-and-suspenders on top of the small disk-cache-size launch flags:
  // tells Chromium not to even consult its (already near-zero) HTTP cache
  // for this page. We never revisit a page, so caching it is pure wasted
  // memory with zero future benefit.
  await page.setCacheEnabled(false);

  // Trim wasted bandwidth/memory/time — we don't need images, fonts, media,
  // or stylesheets to read text data out of the DOM. This is a meaningful
  // chunk of the memory savings on top of the launch flags above, and it
  // incidentally makes requests faster and less bot-pattern-y in timing.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

// Hard-capped cleanup. On Render's free (heavily throttled) CPU, a
// CPU-starved Chromium process can fail to acknowledge a graceful
// browser.close() DevTools command for a very long time — if we just
// `await browser.close()` with no ceiling, this call can hang for minutes.
// Since server.js relies on closeBrowser() settling quickly to avoid
// blocking the HTTP response back to n8n, we give the graceful close a
// window and then force-kill the underlying OS process(es) if it hasn't
// finished — guaranteeing this function always returns promptly.
const CLOSE_TIMEOUT_MS = 8000;

async function closeBrowser() {
  const current = browserPromise;
  const dirToClean = currentUserDataDir;
  browserPromise = null;
  currentUserDataDir = null;

  // Fire-and-forget, but guaranteed to run on EVERY exit path below —
  // whether a browser was ever tracked, closed gracefully, force-killed, or
  // died on its own (the 'disconnected' handler in getBrowser() nulls
  // browserPromise independently, which is why we snapshot dirToClean up
  // front rather than gating cleanup on browserPromise still being set).
  // This is what actually deletes the throwaway profile (cache, cookies,
  // local storage, service workers, everything) regardless of how the
  // browser ended up closing, since Puppeteer only auto-cleans profile
  // dirs it generated itself, not ones we pass in explicitly (see
  // attemptLaunch above).
  const cleanupProfileDir = () => {
    if (dirToClean) {
      fsp.rm(dirToClean, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (!current) {
    cleanupProfileDir();
    return;
  }

  let browser;
  try {
    browser = await current;
  } catch (_) {
    cleanupProfileDir();
    return; // never launched successfully — nothing else to close
  }
  if (!browser) {
    cleanupProfileDir();
    return;
  }

  const proc = browser.process();
  let closedGracefully = false;

  try {
    await Promise.race([
      browser.close().then(() => { closedGracefully = true; }),
      new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
  } catch (_) {
    // browser.close() itself threw — fall through to the force-kill check
  }

  if (!closedGracefully && proc && !proc.killed && proc.pid) {
    // Puppeteer spawns Chromium detached, as the leader of its own process
    // group, exactly so the whole tree can be force-killed together via the
    // negative-PID group-kill. Killing only proc.pid (the old behavior)
    // leaves any child processes it forked as orphans that keep consuming
    // memory indefinitely — see the top-of-file note for why that mattered.
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch (_) {
      // Group kill unsupported (e.g. Windows) or already gone — fall back
      // to killing just the top-level process.
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
    // Extra insurance, fire-and-forget: in case group-kill missed anything
    // (platform quirks, an already-detached grandchild, etc.), sweep any
    // remaining stray chromium processes in the background. Never awaited —
    // must not delay the caller.
    killStrayChromiumProcesses().catch(() => {});
  }

  cleanupProfileDir();
}

function isBrowserLaunched() {
  return browserPromise !== null;
}

module.exports = { getBrowser, newStealthPage, closeBrowser, isBrowserLaunched, killStrayChromiumProcesses };
