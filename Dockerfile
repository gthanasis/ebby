# The web app is the same on every platform: build it once, natively, not under emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app/ app/
RUN uv sync --frozen --no-dev
COPY --from=web /web/dist web/dist
# Non-root, and nothing written outside /data (the root filesystem is read-only in the cluster).
RUN useradd --uid 1000 --user-group --no-create-home app && mkdir -p /data && chown app:app /data
ENV DATA_DIR=/data EB_KEY_PATH=/data/key.pem PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000
VOLUME /data
EXPOSE 8000
CMD ["bank-sync", "serve"]
