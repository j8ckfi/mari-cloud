#!/bin/sh
# SCRATCH — Gate 2 teardown. Removes everything the probe created:
# the throwaway Worker, its Durable Object namespace, the container
# application, and the pushed image. Then delete this directory.
set -eu
export CLOUDFLARE_ACCOUNT_ID=5b7019b38a2b1c0ce119ecf64e92fd92
WR="/Users/j8ck/Mari cloud/node_modules/.pnpm/wrangler@4.114.0_@cloudflare+workers-types@5.20260724.1/node_modules/wrangler/bin/wrangler.js"
cd "$(dirname "$0")"

node "$WR" delete -c wrangler.jsonc --force
node "$WR" containers delete mari-probe-net || true
node "$WR" containers images delete mari-probe-net || true
echo "now: rm -rf '$(pwd)'"
