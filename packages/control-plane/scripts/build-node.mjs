// Bundle the Node entry into a single self-contained ESM file.
//
// A private instance ships as one file plus Node itself (deploy/Dockerfile.control-plane),
// which is what makes "one command" (spec 11.2) true without a package manager
// or a native toolchain in the runtime image.
//
// The one alias is the point of the whole exercise: `cloudflare:workers`
// resolves to the Node base class, so `computer-do.ts` and `events-do.ts` are
// bundled UNFORKED — the same source that runs on Workers.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/node.ts`],
  outfile: `${root}dist/node.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  alias: {
    'cloudflare:workers': `${root}src/node/cloudflare-workers.ts`,
  },
  // `cpu-features` is an optional NATIVE speedup ssh2 probes for inside a
  // try/catch (dockerode only needs ssh2 for ssh:// daemons). It cannot be
  // bundled (.node binary) and must not be: unresolvable is the case ssh2
  // already handles.
  external: ['cpu-features'],
  // CommonJS dependencies bundled into an ESM output still expect `require`,
  // `__filename` and `__dirname` (ssh2, reached through dockerode, uses
  // `__dirname` to probe for an optional native binding at import time).
  banner: {
    js: [
      "import { createRequire as __mariCreateRequire } from 'node:module';",
      "import { fileURLToPath as __mariFileURLToPath } from 'node:url';",
      "import { dirname as __mariDirname } from 'node:path';",
      'const require = __mariCreateRequire(import.meta.url);',
      'const __filename = __mariFileURLToPath(import.meta.url);',
      'const __dirname = __mariDirname(__filename);',
    ].join('\n'),
  },
});
