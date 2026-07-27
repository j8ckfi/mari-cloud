#!/bin/sh
# Fail a hosted release before migration/deploy when the remote Worker is
# missing a required binding or still carries the development-only static R2
# fallback. Wrangler's `secrets.required` affects type generation and local-dev
# warnings; it is not a remote production preflight.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONTROL_PLANE="$ROOT/packages/control-plane"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT HUP INT TERM

if ! pnpm --dir "$CONTROL_PLANE" exec wrangler secret list \
  --env production --format json >"$OUT"; then
  echo "production secret preflight: unable to list remote Worker secrets" >&2
  echo "confirm Cloudflare authentication/account access, then retry" >&2
  exit 1
fi

node --input-type=module - "$OUT" <<'NODE'
import { readFileSync } from 'node:fs';

const file = process.argv[2];
let rows;
try {
  rows = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error('production secret preflight: wrangler returned invalid JSON');
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error('production secret preflight: expected wrangler secret list to return an array');
  process.exit(1);
}

const names = new Set(
  rows.flatMap((row) => {
    if (typeof row === 'string') return [row];
    if (row && typeof row === 'object' && typeof row.name === 'string') return [row.name];
    return [];
  }),
);
const required = [
  'AUTH_SECRET',
  'R2_PARENT_ACCESS_KEY_ID',
  'R2_PARENT_API_TOKEN',
];
const forbidden = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];
const missing = required.filter((name) => !names.has(name));
const unsafe = forbidden.filter((name) => names.has(name));

if (missing.length > 0) {
  console.error(`production secret preflight: missing required bindings: ${missing.join(', ')}`);
}
if (unsafe.length > 0) {
  console.error(
    `production secret preflight: remove development-only static R2 bindings: ${unsafe.join(', ')}`,
  );
}
if (missing.length > 0 || unsafe.length > 0) process.exit(1);

console.log(`production secret preflight: ok (${required.length} required bindings present)`);
NODE
