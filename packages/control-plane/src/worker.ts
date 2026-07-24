// Cloudflare Workers entry (spec 3.1). The Durable Object class is re-exported
// so wrangler can bind it; the fetch handler delegates to the shared pipeline
// (wake proxy, then REST app).

import { handleFetch } from './handler';
import type { Env } from './types';

export { ComputerDO } from './computer-do';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
