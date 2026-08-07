#!/bin/sh
# build → 重啟 wrangler dev → 跑 parity
# wrangler dev 不會可靠地重載新 build 的 chunk，所以每次都重啟。
set -e
cd "$(dirname "$0")/.."
npx astro build >/dev/null 2>&1 || { npx astro build; exit 1; }
pkill -f "wrangler dev" 2>/dev/null || true
sleep 2
npx wrangler dev --port 8787 > /tmp/gleanstudio-wrangler.log 2>&1 &
for i in $(seq 1 30); do sleep 1; curl -s -o /dev/null http://localhost:8787/ 2>/dev/null && break; done
sleep 1
node scripts/parity-diff.mjs "$@"
