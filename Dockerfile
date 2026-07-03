# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

# Install Camoufox and fetch Firefox binary for Google automation
RUN npm list camoufox-js || npm install camoufox-js
RUN npx camoufox-js fetch || echo "⚠️  Camoufox fetch failed during build, will retry at runtime"

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Prepare Camoufox files for copying (create marker if they exist)
RUN mkdir -p /tmp/camoufox-export && \
  (test -d /root/.camoufox && cp -r /root/.camoufox /tmp/camoufox-export/.camoufox && echo "Camoufox binary found" || echo "Camoufox binary not found") && \
  (test -d /app/node_modules/camoufox-js && cp -r /app/node_modules/camoufox-js /tmp/camoufox-export/camoufox-js && echo "camoufox-js package found" || echo "camoufox-js package not found")

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next

# Copy Camoufox files from export directory (will be empty if not installed)
COPY --from=builder /tmp/camoufox-export /tmp/camoufox-import

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Move Camoufox files to final location if they exist
RUN (test -d /tmp/camoufox-import/.camoufox && mv /tmp/camoufox-import/.camoufox /app/data-home/.camoufox && echo "Camoufox binary installed" || echo "Camoufox binary not found, will download at runtime") && \
  (test -d /tmp/camoufox-import/camoufox-js && mv /tmp/camoufox-import/camoufox-js ./node_modules/camoufox-js && echo "camoufox-js package installed" || echo "camoufox-js package not found, will install at runtime") && \
  rm -rf /tmp/camoufox-import

# Fix permissions at runtime (handles mounted volumes)
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null || true\nmkdir -p /app/data/db /app/data/db/backups 2>/dev/null || true\nchown -R node:node /app/data 2>/dev/null || true\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
