// Fork (spec 9.1): a fork is a manifest-head copy with lineage that transfers
// NO bulk data. Asserts the new computer's head equals the source's, and that
// the R2 object count is unchanged (no chunks copied).
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, computerStub, cookieFromSetCookie } from './helpers';

const HOST = 'http://localhost';

async function r2ObjectCount(): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  // Page through, in case future seeds grow the store.
  do {
    const page = await env.STORE.list(cursor ? { cursor } : undefined);
    count += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return count;
}

describe('fork', () => {
  let cookie = '';
  let sourceId = '';
  let sourceHead = '';

  beforeAll(async () => {
    const res = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
    const body = (await res.json()) as { computer: { id: string; head: string } };
    cookie = cookieFromSetCookie(res.headers.get('set-cookie'));
    sourceId = body.computer.id;
    sourceHead = body.computer.head;
  });

  it('creates a fork whose head equals the source, copying zero chunks', async () => {
    const before = await r2ObjectCount();

    const res = await SELF.fetch(`${HOST}/api/computers/${sourceId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my fork' }),
    });
    expect(res.status).toBe(201);
    const fork = (await res.json()) as {
      id: string;
      head: string;
      parentComputer: string;
      state: string;
    };

    // Head copied, lineage recorded, starts COLD.
    expect(fork.head).toBe(sourceHead);
    expect(fork.parentComputer).toBe(sourceId);
    expect(fork.state).toBe('cold');
    expect(fork.id).not.toBe(sourceId);

    // The fork's DO carries the same head, and it was not woken.
    const forkStub = computerStub(fork.id);
    expect(await forkStub.getHead()).toBe(sourceHead);
    expect(await forkStub.getState()).toBe('cold');

    // NO bulk data moved: the R2 object count is unchanged (spec 9.1).
    const after = await r2ObjectCount();
    expect(after).toBe(before);

    // The fork appears in the fleet list with its parent lineage.
    const list = (await (
      await SELF.fetch(`${HOST}/api/computers`, { headers: { Cookie: cookie } })
    ).json()) as { computers: { id: string; parentComputer: string | null }[] };
    const listed = list.computers.find((c) => c.id === fork.id);
    expect(listed?.parentComputer).toBe(sourceId);
  });
});
