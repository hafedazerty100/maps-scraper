// A small pool of real, current-ish desktop user agents. Rotating between a
// handful of legit UAs is more convincing than one fixed string, and far
// more convincing than leaving Puppeteer's default (which screams "bot").
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

// Kept deliberately small/modest. Every extra pixel here is extra compositor
// + rasterizer memory inside Chromium. On a 512MB box that adds up fast, so
// we dropped 1920x1080 from the old pool and added a smaller 1024x768 option.
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomUserAgent() {
  return pickRandom(USER_AGENTS);
}

function randomViewport() {
  return pickRandom(VIEWPORTS);
}

// Sleep for a random duration between min and max ms. Used everywhere instead
// of fixed waits so request timing doesn't look like a robotic fixed cadence.
function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Move the mouse in a few small random steps before clicking, instead of
// teleporting straight to the target. Cheap but meaningfully more human-like
// than Puppeteer's default instant click.
async function humanClick(page, elementHandle) {
  const box = await elementHandle.boundingBox();
  if (!box) {
    await elementHandle.click();
    return;
  }
  const targetX = box.x + box.width / 2 + (Math.random() * 10 - 5);
  const targetY = box.y + box.height / 2 + (Math.random() * 10 - 5);

  const steps = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < steps; i++) {
    const progress = (i + 1) / steps;
    await page.mouse.move(targetX * progress, targetY * progress, { steps: 2 });
    await randomDelay(15, 40);
  }
  await page.mouse.click(targetX, targetY);
}

// Scroll Google Maps' results feed panel gradually (like a real user reading
// down the list) instead of jumping straight to the bottom. Stops once no
// new results load after a few tries, or the desired count is reached.
async function scrollResultsFeed(page, feedSelector, { desiredCount, maxIdleRounds = 3 }) {
  let previousCount = 0;
  let idleRounds = 0;

  while (idleRounds < maxIdleRounds) {
    const currentCount = await page.evaluate((sel) => {
      const feed = document.querySelector(sel);
      if (!feed) return 0;
      return feed.querySelectorAll('a.hfpxzc').length;
    }, feedSelector);

    if (currentCount >= desiredCount) break;

    if (currentCount === previousCount) {
      idleRounds += 1;
    } else {
      idleRounds = 0;
    }
    previousCount = currentCount;

    await page.evaluate((sel) => {
      const feed = document.querySelector(sel);
      if (feed) feed.scrollBy(0, 600 + Math.random() * 400);
    }, feedSelector);

    await randomDelay(500, 1100);
  }

  return previousCount;
}

module.exports = {
  randomUserAgent,
  randomViewport,
  randomDelay,
  humanClick,
  scrollResultsFeed,
};
