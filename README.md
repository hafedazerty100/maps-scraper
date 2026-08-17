# maps-scraper — fixed for Render free tier (512MB / 1 vCPU)

Headless-browser Google Maps lead scraper (business name, website, phone,
email) with an HTTP API for n8n to call.

---

## 1. What was actually breaking it

You described the exact symptom of one specific bug: **"worked once, then
never works again, keeps failing after taking a long time."**

The old `browser.js` launched a single Chromium instance the first time it
was needed and then **cached it forever**:

```js
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) browserPromise = puppeteerExtra.launch({ ... });
  return browserPromise;
}
```

On Render's free plan (512MB RAM, 1 shared vCPU) a headless Chromium process
runs right at the edge of the memory ceiling. The **first** time it gets
OOM-killed or its renderer crashes — which is close to inevitable under
those constraints, especially scraping a JS-heavy page like Google Maps —
the Node.js process itself stays alive, but `browserPromise` now points to a
**dead browser**. Every request after that calls `.newPage()` on a corpse:
it either throws immediately or hangs until an internal timeout, which is
exactly "takes a long time then fails." The only fix, until now, was
manually restarting the Render service.

That's the root cause. Everything below fixes that, plus trims memory
and wasted time so it actually fits a 512MB box.

### Everything that changed

| File | What changed | Why |
|---|---|---|
| `src/browser.js` | `getBrowser()` now checks `browser.isConnected()` and relaunches if the cached instance died. Also listens for the `'disconnected'` event to invalidate the cache the instant Chromium dies. | **This is the actual bug fix.** The service can no longer get permanently wedged by a crash. |
| `src/server.js` | The browser is now explicitly **closed after every single job**, success or failure, via a `runJob()` wrapper. A hard per-job timeout (`JOB_TIMEOUT_MS`) force-kills stuck jobs. | Guarantees every request starts from a clean, low-memory state instead of an aging, possibly-leaking browser session. Costs ~1-2s to relaunch Chromium per request — a small price for never getting stuck again. |
| `src/browser.js` | Added ~25 memory-saving Chromium launch flags (disable extensions/sync/translate/background-timers/etc.), `--single-process` mode (toggleable), a capped renderer JS heap, and blocked `stylesheet` requests on top of the existing image/font/media blocking. | Chromium's *default* footprint is too heavy for 512MB. These flags routinely save 150-250MB combined. |
| `src/utils.js` | Smaller viewport pool (dropped 1920×1080, added 1024×768); trimmed some randomized delay ranges. | Smaller viewport = smaller compositor buffers = less memory. Shorter (but still randomized, still human-like) delays = faster jobs. |
| `src/mapsScraper.js` | Consent-banner detection now does one in-page scan instead of one round-trip per button; capped the max number of result cards scanned per query instead of an unbounded `limit * 8`. | Fewer IPC round-trips, less DOM growth per job = faster and lighter. |
| `Dockerfile` | Added `NODE_OPTIONS=--max-old-space-size=180` to cap Node's own heap. | Stops Node itself from eating into the memory budget Chromium needs. |
| `.env` | Lowered `DEFAULT_LIMIT`/`MAX_LIMIT`, added `CHROME_SINGLE_PROCESS`, `RENDERER_HEAP_MB`, `JOB_TIMEOUT_MS`. | Smaller batches finish faster and are far less likely to hit the memory ceiling mid-job. |
| `/health` | Now also reports live memory usage (`rss`, `heapUsed`) and whether a browser is currently active. | So you can actually see what's happening in Render's logs instead of guessing. |

### Update — a second, related bug fixed after real-world testing

The fix above (browser recycling) stopped the service from getting
*permanently* wedged. But a follow-up report surfaced a second bug: a single
job could hang for 8+ minutes with **zero response**, until n8n's own
connection timeout gave up (`ECONNABORTED`).

Cause: `JOB_TIMEOUT_MS` was correctly firing at 100s, but the cleanup step
(`await closeBrowser()`) ran *before* the HTTP response was sent. On Render's
throttled free CPU, a CPU-starved Chromium process can fail to acknowledge a
graceful `browser.close()` command for a very long time — so the response
back to n8n was stuck waiting behind a browser that was too starved to even
confirm it was closing.

Fixed in `src/browser.js` (`closeBrowser()` now force-`SIGKILL`s the
Chromium process if it doesn't close gracefully within 5s) and `src/server.js`
(`runJob()` no longer awaits cleanup before responding — it fires cleanup in
the background and responds to n8n as soon as the job/timeout outcome is
known). The server should now always respond within roughly `JOB_TIMEOUT_MS`
+ a few seconds, never longer.

### Update — split into two phases: search (URLs only) → enrich (per lead)

Following on from the fixes above, `/scrape-leads` was further changed so it
**only collects `{ name, mapsUrl }`** — it no longer opens each business's
detail pane or visits their website. That heavy work moved entirely to
`/enrich-lead`, which you now call once per `mapsUrl` (looped from n8n).

Why this is better on 512MB, not just a preference:
- The search phase is now dramatically lighter — no detail-pane loads, no
  website visits — so it finishes fast and rarely gets near the memory
  ceiling, even at higher `limit`s.
- Enrichment is isolated per lead. If one business's website is slow or
  broken, you lose that one enrichment call, not the whole batch.
- You can enrich only the leads you actually want (e.g. skip ones you
  already have from a previous run) instead of paying the cost for all of
  them up front.

### Update — orphaned Chromium processes fixed (the "works once then always 500s" bug)

A third bug surfaced in production: after the first request, every
subsequent call failed with `"Timed out ... while waiting for the WS
endpoint URL to appear in stdout"` — meaning Chromium couldn't even *start*,
not just crash mid-job.

Cause: the force-kill added in the previous fix only sent `SIGKILL` to
Chromium's top-level process ID. Puppeteer spawns Chromium as the leader of
its own process group specifically so the *entire* tree (any
renderer/utility/crashpad child processes it forked) can be killed together
— killing only the leader orphaned those children instead. They kept
running and kept holding memory. Under Render's CPU throttling, graceful
closes hang often enough that this compounded fast: by the 2nd or 3rd
request there wasn't enough RAM left for a new Chromium to boot at all.

Fixed in `src/browser.js`: the force-kill now targets the whole process
group (`process.kill(-pid, 'SIGKILL')` instead of `proc.kill(...)`), plus a
system-wide stray-process sweep (`pkill -9 -f chromium`) runs automatically
if every launch attempt still fails, and once at server startup as extra
insurance for services already running before this fix was deployed.

**If you already had the previous version deployed**, restart your Render
service once after deploying this update — that clears out any Chromium
processes that were already orphaned before the fix was in place.

### Update — scorched-earth cleanup, since we never revisit a page

Since every business/website is visited exactly once and never again, there
is zero value in Chromium caching or retaining anything from that visit.
This round strips all of that out proactively instead of letting it
accumulate and rely on cleanup after the fact:

- **Disk cache disabled entirely** at the Chromium launch level
  (`--disk-cache-dir=/dev/null` + zeroed cache sizes) — nothing gets written
  to cache in the first place.
- **Per-page HTTP cache disabled** (`page.setCacheEnabled(false)`) as a
  second layer on top of the launch flags.
- **Explicit, self-managed temp browser profile per launch.** Previously
  Puppeteer generated its own profile directory internally and only
  auto-deleted it after a *graceful* close — meaning a force-killed browser
  (see the previous fix) could leave its temp profile (any cache/cookies/
  storage that slipped through) sitting on disk. Now the app creates and
  owns that directory itself, and guarantees its deletion on every possible
  exit path — graceful close, forced kill, or a browser that died on its
  own mid-job — not just the happy path.
- **Proactive V8 heap reclaim.** Node normally hands freed memory back to
  the OS lazily, on its own schedule. `server.js` now forces a GC pass
  (`global.gc()`, enabled via `--expose-gc` in the Dockerfile) right after
  every job finishes, so memory a completed job used gets released
  immediately instead of drifting.

None of this changes request/response behavior — it's purely about leaving
nothing behind once a response is sent.

### Update — fixed consistent "Navigation timeout of 45000ms exceeded"

After the previous round, every request started failing with a navigation
timeout. Cause: `page.goto()` for the Maps search page used
`waitUntil: 'networkidle2'` — which requires the page's network activity to
drop to ≤2 connections for 500ms before Puppeteer considers navigation
"done." Google Maps is a heavy SPA that keeps background connections alive
continuously (live traffic data, tile loading, telemetry pings) — it can
genuinely **never** satisfy that condition, so this wait could hang for the
full 45s on every single request regardless of how fast the page actually
rendered underneath.

Fixed: switched to `waitUntil: 'domcontentloaded'` (fires as soon as the
initial HTML/JS is parsed) followed by the explicit
`page.waitForSelector(FEED_SELECTOR)` the code already had — that selector
wait is the real signal that matters (the results feed has actually
hydrated), and it's both faster and far more reliable than waiting on
network activity for a page like this. Applied to both Maps-search
functions and the generic `/extract-xpath` endpoint (any sufficiently
"alive" website, not just Maps, could hit the same issue).

Also walked back `--disk-cache-dir=/dev/null` from the previous round —
it's a commonly-suggested trick but can be flaky on some Chromium builds
(it's a device file, not a real directory) and was a plausible contributor
to the slowdown. The near-zero `--disk-cache-size` flags plus
`page.setCacheEnabled(false)` plus deleting the whole profile directory
after every job (added last round) achieve the same "nothing cached, ever"
outcome without that specific risk.

**Be realistic about the hardware.** 512MB/1 shared vCPU is genuinely tight
for running a full Chromium browser. These fixes make the service *reliable*
(it will never again get stuck in a broken state) and meaningfully *faster*
per job — but they cannot make Chromium itself weigh less than it does.
Occasional single-job failures under real load spikes are still possible;
the difference now is the **next** request just works, instead of every
request failing until you manually restart the service.

---

## 2. Deploy to Render — step by step

### Step 1 — Push this project to GitHub
1. Unzip the project you got from me.
2. Create a new GitHub repo (public or private, either works).
3. From inside the project folder:
   ```bash
   git init
   git add .
   git commit -m "maps-scraper - fixed for Render free tier"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
   Note: `.env` is in `.gitignore` on purpose — your real API key never gets
   pushed to GitHub. You'll enter it directly in Render's dashboard instead.

### Step 2 — Create the Web Service on Render
1. Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
2. Connect your GitHub account if you haven't, then select the repo you just pushed.
3. Render will detect the `Dockerfile` automatically. If it asks:
   - **Environment**: `Docker`
   - **Region**: pick whichever is closest to you (or closest to your n8n instance)
   - **Branch**: `main`
   - **Instance Type**: **Free**
4. Click **Advanced** and set **Health Check Path** to `/health`.
   This lets Render know the service is alive without ever spinning up
   Chromium — the health check itself uses almost no memory.

### Step 3 — Add environment variables
Still on the create-service screen (or afterwards under **Environment**),
add every variable from `.env.example` in this project. The important ones:

| Key | Value |
|---|---|
| `API_KEY` | Generate your own: run `openssl rand -hex 24` locally, or use the one already filled into the `.env` I gave you |
| `HEADLESS` | `true` |
| `MAX_CONCURRENCY` | `1` |
| `CHROME_SINGLE_PROCESS` | `true` |
| `RENDERER_HEAP_MB` | `256` |
| `JOB_TIMEOUT_MS` | `100000` |
| `DEFAULT_LIMIT` | `10` |
| `MAX_LIMIT` | `25` |
| `PROXY_SERVER` | leave empty unless you have one |

Do **not** set `PORT` — Render injects its own and this app already reads
`process.env.PORT` automatically.

*(If you'd rather not fill these in by hand, the project also includes a
`render.yaml` — choose **New > Blueprint** instead of **New > Web Service**
and Render pre-fills everything except `API_KEY`.)*

### Step 4 — Deploy
Click **Create Web Service**. First build takes a few minutes (installing
Chromium + npm packages). Watch the **Logs** tab — you should see:
```
maps-scraper API listening on port 10000
```

### Step 5 — Verify it's alive
```bash
curl https://<your-service>.onrender.com/health
```
Expected:
```json
{"status":"ok","queued":0,"running":0,"browserActive":false,"memoryMB":{"rss":45,"heapUsed":20}}
```
`browserActive` will be `false` at rest — that's correct, the browser is
only launched per-job and closed right after (that's the fix).

### Step 6 — Test a real scrape
```bash
curl -X POST https://<your-service>.onrender.com/scrape-leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your API_KEY>" \
  -d '{"query": "coffee shop in Algiers", "limit": 5}'
```
This first request will be slow (Render free instances spin down after ~15
minutes idle — first request "cold starts" the whole container, on top of
launching Chromium). That's normal and unavoidable on the free plan. Every
request after that, while the service stays warm, will be meaningfully
faster.

---

## 3. The two-phase workflow: search then enrich

**Phase 1 — `POST /scrape-leads`** (fast, lightweight): scrolls the Maps
results feed and returns just `{ name, mapsUrl }` per business. No detail
panes opened, no websites visited.

```json
// Request
{ "query": "dentist in bay area", "limit": 15, "excludeUrls": [] }

// Response
{
  "query": "dentist in bay area",
  "count": 15,
  "results": [
    { "name": "Bay Dental Care", "mapsUrl": "https://www.google.com/maps/place/..." },
    ...
  ]
}
```

**Phase 2 — `POST /enrich-lead`** (one call per lead): visits that single
place page and returns the full picture — website, phone, address, rating,
category, email, and where the email came from.

```json
// Request
{ "mapsUrl": "https://www.google.com/maps/place/..." }

// Response
{
  "mapsUrl": "https://www.google.com/maps/place/...",
  "name": "Bay Dental Care",
  "website": "https://baydentalcare.com",
  "phone": "+1 555-0100",
  "address": "123 Main St, ...",
  "rating": "4.8",
  "category": "Dentist",
  "email": "info@baydentalcare.com",
  "emailSource": "website"
}
```

### Wiring this in n8n
1. **HTTP Request node** → `POST /scrape-leads` → returns your list of `{ name, mapsUrl }`.
2. **Split Out / Loop Over Items node** on the `results` array.
3. Inside the loop, **HTTP Request node** → `POST /enrich-lead` with `{ "mapsUrl": "={{ $json.mapsUrl }}" }`.
4. Merge/aggregate the enriched results back into your sheet.

Keep the loop **sequential**, not parallel — the server only processes one
job at a time regardless (`MAX_CONCURRENCY=1`), so running the loop items in
parallel from n8n just means most of them sit waiting instead of actually
finishing faster.

### Basic HTTP setup (applies to both endpoints)
Use an **HTTP Request** node:

- **Method**: `POST`
- **URL**: `https://<your-service>.onrender.com/scrape-leads`
- **Authentication**: None (auth is via header below)
- **Headers**:
  - `Content-Type: application/json`
  - `x-api-key: <your API_KEY>`
- **Body** (JSON):
  ```json
  {
    "query": "={{ $json.searchQuery }}",
    "limit": 15,
    "excludeUrls": {{ $json.previousMapsUrls }}
  }
  ```
- **Settings → Timeout**: set to **150000ms (150s)** — this must be *higher*
  than `JOB_TIMEOUT_MS` (100000ms) on the server so n8n never gives up before
  the server itself has had a chance to time out and respond. The server now
  always responds within `JOB_TIMEOUT_MS` + a few seconds (see the cleanup
  fix above), so 150s gives comfortable margin without you needing to set
  5-minute waits like before.

### For very large totals, page through with excludeUrls
`/scrape-leads` is light enough now that `limit: 15-40` in one call is fine.
If you want more than `MAX_LIMIT` total for one query, loop a few calls,
feeding each call's returned `mapsUrl`s into the next call's `excludeUrls`
so you get fresh businesses each time instead of repeats.

### Keeping it warm (optional)
Render free services spin down after ~15 minutes of no HTTP traffic. If cold
starts are a problem, set up a free [UptimeRobot](https://uptimerobot.com)
monitor pinging `GET /health` every 10 minutes. That endpoint never touches
Chromium, so it costs you nothing memory-wise and just keeps the container
warm.

### Other endpoints available
- `POST /find-email` — `{ "website": "https://..." }` — standalone email lookup, no Maps involved
- `POST /enrich-lead` — `{ "mapsUrl": "https://www.google.com/maps/place/..." }` — re-visit one listing and fill in missing fields/email
- `POST /extract-xpath` — `{ "url", "xpath", "fetchTarget": bool }` — generic XPath scraping utility, unrelated to Maps

---

## 4. Testing locally before deploying (optional)

```bash
docker compose up --build
```
`docker-compose.yml` sets `mem_limit: 512m` on purpose — it simulates
Render's free-tier ceiling on your own machine, so you catch memory issues
before they show up in production.

```bash
curl -X POST http://localhost:3000/scrape-leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your API_KEY>" \
  -d '{"query": "dentist in Oran", "limit": 5}'
```

---

## 5. Troubleshooting

**Service returns 401** → your `x-api-key` header doesn't match `API_KEY` in
Render's environment variables. Check for trailing spaces/typos.

**First request after idle is very slow (~30-60s+)** → normal Render free
cold start, not a bug. Consider the UptimeRobot keep-warm trick above.

**Job fails with `"Job exceeded 100000ms timeout"`** → the query is too
broad/slow for the free CPU. Lower `limit`, or raise `JOB_TIMEOUT_MS`
(remembering to raise n8n's node timeout to match).

**Check `/health`'s `memoryMB.rss` right after a scrape** — if it's
regularly near 450-500, you're at the ceiling. Lower `MAX_LIMIT` and
`RENDERER_HEAP_MB` further, or consider Render's cheapest paid tier
(1-2GB RAM) if your volume genuinely needs it — no amount of tuning gets a
full Chromium browser reliably comfortable forever on 512MB under heavy use.

**Render logs show repeated crashes/restarts** → check for
`--single-process` instability; set `CHROME_SINGLE_PROCESS=false` in Render's
env vars and redeploy (no code change needed, it's an env var).

**Google is serving CAPTCHAs / blocking requests** → this happens to any
scraper run at volume from a single IP, Render's included. Add a residential
or datacenter `PROXY_SERVER` and rotate it, and keep volume modest.
