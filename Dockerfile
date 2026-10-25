# syntax=docker/dockerfile:1.7

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential liblzma5 python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev \
    && find node_modules -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS runtime-base
ARG TARGETARCH
ARG NPM_VERSION=11.18.0
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
LABEL org.opencontainers.image.source=https://github.com/oll4com/spaceapp
LABEL org.opencontainers.image.licenses=MIT
RUN npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
    && install -d /tmp/npm-security-patches \
    && npm pack --ignore-scripts --no-audit --no-fund --pack-destination /tmp/npm-security-patches \
      brace-expansion@5.0.12 tar@7.5.21 ip-address@10.7.4 undici@6.28.1 postcss-selector-parser@7.1.6 \
    && rm -rf \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/tar \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/undici \
      /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser \
    && install -d \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/tar \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/undici \
      /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser \
    && tar -xzf /tmp/npm-security-patches/brace-expansion-5.0.12.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/tar-7.5.21.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/tar --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/ip-address-10.7.4.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/ip-address --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/undici-6.28.1.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/undici --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/postcss-selector-parser-7.1.6.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser --strip-components=1 \
    && rm -rf /tmp/npm-security-patches \
    && npm cache clean --force \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git gosu liblzma5 postgresql-client procps ripgrep sqlite3 \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 spaceapp \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /var/lib/spaceapp-cli --shell /bin/bash spaceapp
WORKDIR /app
COPY --chown=spaceapp:spaceapp deploy/docker ./deploy/docker
COPY --from=build --chown=spaceapp:spaceapp /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=spaceapp:spaceapp /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
RUN chmod 0755 deploy/docker/core-entrypoint.sh deploy/docker/browser-entrypoint.sh deploy/docker/cli-entrypoint.sh \
    && install -m 0755 deploy/docker/public-cli-wrapper.sh /usr/local/bin/spaceapp-cli-wrapper \
    && for name in codex claude gemini opencode qwen kimi grok deepseek autohand cursor copilot; do \
         ln -s /usr/local/bin/spaceapp-cli-wrapper "/usr/local/bin/${name}-vscode-parity"; \
       done

# --- Per-target dependency closures ---

FROM runtime-base AS core-deps
WORKDIR /app
COPY --from=build --chown=spaceapp:spaceapp /app/package.json /app/package-lock.json ./
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/memory-graph/package.json ./packages/memory-graph/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/opencode-control/package.json ./packages/opencode-control/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/streaming/package.json ./packages/streaming/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/browser-host/package.json ./packages/browser-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/package.json ./packages/cli-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/codex-app-server/package.json ./packages/codex-app-server/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/icons/package.json ./packages/icons/package.json
RUN npm install --ignore-scripts --no-audit --no-fund --omit=dev \
    --workspace=@space/api \
    --workspace=@space/worker \
    --workspace=@space/web \
    --workspace=@space/db

FROM runtime-base AS browser-deps
WORKDIR /app
COPY --from=build --chown=spaceapp:spaceapp /app/package.json /app/package-lock.json ./
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/memory-graph/package.json ./packages/memory-graph/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/opencode-control/package.json ./packages/opencode-control/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/streaming/package.json ./packages/streaming/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/browser-host/package.json ./packages/browser-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/package.json ./packages/cli-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/codex-app-server/package.json ./packages/codex-app-server/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/icons/package.json ./packages/icons/package.json
RUN npm install --ignore-scripts --no-audit --no-fund --omit=dev \
    --workspace=@space/api

FROM runtime-base AS cli-deps
WORKDIR /app
COPY --from=build --chown=spaceapp:spaceapp /app/package.json /app/package-lock.json ./
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/package.json ./packages/cli-host/package.json
RUN npm install --ignore-scripts --no-audit --no-fund --omit=dev \
    --workspace=@space/cli-host

# --- Final target images ---

FROM runtime-base AS core
COPY --from=core-deps --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=spaceapp:spaceapp /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=spaceapp:spaceapp /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=spaceapp:spaceapp /app/apps/web/server.mjs ./apps/web/server.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/dist ./packages/db/dist
COPY --chown=spaceapp:spaceapp starter-memory /opt/spaceapp/starter-memory
RUN install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /var/lib/spaceapp/memory \
      /run/spaceapp-cli
EXPOSE 4911
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4911/readyz').then(async r=>{const body=await r.json();if(!r.ok||body.ok !== true)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/deploy/docker/core-entrypoint.sh"]

FROM runtime-base AS browser
COPY --from=browser-deps --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/dist/browser-host-main.js ./apps/api/dist/browser-host-main.js
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation liblzma5 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /run/spaceapp-browser
ENV SPACE_BROWSER_CHROME_PATH=/usr/bin/chromium \
    SPACE_BROWSER_SESSIONS_CHROME_PATH=/usr/bin/chromium
ENTRYPOINT ["/app/deploy/docker/browser-entrypoint.sh"]

FROM runtime-base AS cli
COPY --from=cli-deps --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/dist ./packages/cli-host/dist
COPY --chown=root:root starter-memory/AGENTS.md /etc/AGENTS.md
COPY --chown=root:root starter-memory/installation-guide.md /etc/spaceapp-installation-guide.md
RUN chmod 0644 /etc/AGENTS.md
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @opencode/cli@2.0.32 \
    && install -d -o spaceapp -g spaceapp -m 0700 /var/lib/spaceapp-cli/vendor \
    && npm cache clean --force \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp-cli \
      /var/lib/spaceapp-cli/providers \
      /var/lib/spaceapp-cli/imported-credentials \
      /var/lib/spaceapp/memory \
      /workspaces \
      /run/spaceapp-cli \
    && printf '%s\n' "$TARGETARCH" > /usr/local/share/spaceapp-cli-architecture
COPY --chown=spaceapp:spaceapp agent-skills ./agent-skills
RUN ln -s /etc /opt/spaceapp
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
