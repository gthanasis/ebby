# The web app is the same on every platform: build it once, natively, not under emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# The server: TypeScript compiled to JavaScript, then only what it needs to run.
FROM node:24-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=server /app/server/package.json server/package.json
COPY --from=server /app/server/node_modules server/node_modules
COPY --from=server /app/server/dist server/dist
COPY server/migrations server/migrations
COPY --from=web /web/dist web/dist
# `ebby serve`, `ebby demo-seed`, `ebby add-user`; bank-sync is the name older instructions use.
RUN printf '#!/bin/sh\nexec node /app/server/dist/main.js "$@"\n' > /usr/local/bin/ebby && chmod 755 /usr/local/bin/ebby \
    && ln -s ebby /usr/local/bin/bank-sync \
    && mkdir -p /data && chown 1000:1000 /data
# Non-root (the image's node user), and nothing written outside /data (the root filesystem is read-only in the cluster).
ENV DATA_DIR=/data EB_KEY_PATH=/data/key.pem NODE_ENV=production
USER 1000:1000
VOLUME /data
EXPOSE 8000
CMD ["ebby", "serve"]
