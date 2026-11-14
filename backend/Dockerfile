FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS backend
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg poppler-utils python3-venv zip \
    && python3 -m venv /opt/tts \
    && /opt/tts/bin/pip install --no-cache-dir edge-tts==7.3.1 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /data /render-spool
ENV PATH="/opt/tts/bin:${PATH}" KNOVID_DATA=/data KNOVID_SPOOL=/render-spool
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json openapi.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node assets ./assets
USER node

FROM backend AS renderer
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_EXECUTABLE=/usr/bin/chromium REMOTION_CHROME_MODE=chrome-for-testing \
    XDG_CACHE_HOME=/tmp/cache XDG_CONFIG_HOME=/tmp/config HOME=/tmp
USER node
