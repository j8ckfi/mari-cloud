// Test-only ambient types: bind the `cloudflare:test` ProvidedEnv to our real
// Env so `env.COMPUTER`/`env.DB`/`env.STORE` are typed in tests. (Runtime tests
// are transpiled by esbuild, which ignores types; this is for editor/tsc.)
import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
