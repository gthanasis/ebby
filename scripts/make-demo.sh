#!/usr/bin/env bash
# The README's screenshots, demo video and GIF, from made-up data (app/demo.py). Nobody's real money.
#
#   scripts/make-demo.sh      -> docs/demo.mp4, docs/demo.gif, docs/hero.png, docs/banner-*.png, docs/screens/*.png
#
# Needs Docker with the local Postgres from the README (bank-sync-pg on 55432), ffmpeg and uv.
# Uses its own database, bank_sync_demo, so your own local data is never touched.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OWNER="${DEMO_OWNER_URL:-postgresql://bank_sync_owner:owner@localhost:55432}"
PORT=8020
OUT="$(mktemp -d)"
trap 'kill "${SERVER:-0}" 2>/dev/null || true; rm -rf "$OUT"' EXIT

export DATABASE_OWNER_URL="$OWNER/bank_sync_demo"
export DATABASE_URL="postgresql://bank_sync_app:app@localhost:55432/bank_sync_demo"
export DEMO=1 PUBLIC_URL="http://localhost:$PORT" GOOGLE_CLIENT_ID= APP_PASSWORD= ANTHROPIC_API_KEY=
# A public-looking callback, so the Banks page reads as it does in production rather than a local run.
export EB_REDIRECT_URL="https://spending.example.com/eb-callback"

uv run python -c "
import psycopg
with psycopg.connect('$OWNER/postgres', autocommit=True) as pg:
    pg.execute('DROP DATABASE IF EXISTS bank_sync_demo WITH (FORCE)')
    pg.execute('CREATE DATABASE bank_sync_demo')"
uv run bank-sync demo-seed
npm --prefix web run build >/dev/null

uv run uvicorn app.server:app --port "$PORT" --log-level warning &
SERVER=$!
for _ in $(seq 1 40); do curl -sf "localhost:$PORT/api/healthz" >/dev/null && break; sleep 0.5; done

uv run --with playwright python scripts/demo.py "http://localhost:$PORT" "$OUT"

mkdir -p docs/screens
cp "$OUT"/screens/*.png docs/screens/
# Trim the page-load flash at the start, then a small MP4 and a GIF for the README.
ffmpeg -loglevel error -y -ss 0.6 -i "$OUT/raw.webm" -vf "fps=30,scale=402:-2" -c:v libx264 -crf 26 -pix_fmt yuv420p -movflags +faststart docs/demo.mp4
ffmpeg -loglevel error -y -ss 0.6 -i "$OUT/raw.webm" -vf "fps=8,scale=300:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" docs/demo.gif
# Three phones side by side for the top of the README.
ffmpeg -loglevel error -y -i docs/screens/overview-dark.png -i docs/screens/spending-dark.png -i docs/screens/goals-dark.png \
  -filter_complex "[0]scale=600:-1,format=rgba,pad=iw+60:ih:30:0:color=0x00000000[a];[1]scale=600:-1,format=rgba,pad=iw+60:ih:30:0:color=0x00000000[b];[2]scale=600:-1,format=rgba,pad=iw+60:ih:30:0:color=0x00000000[c];[a][b][c]hstack=3" docs/hero.png
uv run --with playwright python scripts/make-banner.py
ls -la docs/demo.mp4 docs/demo.gif docs/hero.png docs/banner-*.png
