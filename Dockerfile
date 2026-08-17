FROM node:20-slim

# System Chromium + the shared libs it needs headless, instead of letting
# puppeteer download its own copy (smaller image, works on both amd64/arm64).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Caps Node's own V8 heap so the Node process itself can't balloon and eat
# the memory budget Chromium needs. On a 512MB box: ~180MB for Node,
# leaving the rest for Chromium (which is capped separately via
# RENDERER_HEAP_MB + the launch flags in src/browser.js).
# --expose-gc makes global.gc() available so server.js can proactively
# reclaim Node's own heap right after each job finishes, instead of waiting
# on V8's own schedule — see the comment in server.js's runJob().
ENV NODE_OPTIONS="--max-old-space-size=180 --expose-gc"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# Run as a non-root user — Chromium's sandbox is disabled via launch args,
# so not running as root is the meaningful remaining containment boundary.
RUN groupadd -r scraper && useradd -r -g scraper -G audio,video scraper \
    && mkdir -p /home/scraper/Downloads \
    && chown -R scraper:scraper /home/scraper /app
USER scraper

EXPOSE 3000

CMD ["node", "src/server.js"]
