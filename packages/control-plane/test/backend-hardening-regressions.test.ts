// Focused regressions for the v0.1 backend hardening pass. These assertions are
// intentionally behavior-level: tenancy is visible in object keys and minted
// credential scopes, quota insertion is one atomic D1 statement, lifecycle
// transitions reach both ledgers, and permanent delete destroys paid resources
// before removing content-bearing records.

import { encodeCbor, type Manifest } from '@mari/shared';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { toArrayBuffer } from '../src/bytes';
import { insertComputerWithinLimit } from '../src/db/fleet';
import { handleFetch } from '../src/handler';
import {
  chunkIdOf,
  chunkKey,
  encodeChunkBody,
  ensureEmptyBaseManifest,
  ensureManifestNamespace,
  loadManifest,
  manifestIdOf,
  manifestKey,
  readFile,
} from '../src/manifest-store';
import {
  accumulateAwakeInterval,
  currentPeriod,
  splitUsagePeriods,
  usageFor,
} from '../src/limits';
import {
  composeStoreEnv,
  storeCredentialObjects,
  storeCredentialPrefixes,
  tenantStoreParentRoot,
  tenantStoreRoot,
  tenantStoreUri,
} from '../src/r2-credentials';
import type { FakeSubstrate } from '../src/substrate';
import type { ComputerDO } from '../src/computer-do';
import type { Env } from '../src/types';
import {
  computerStub,
  createComputer,
  delay,
  ensureSchema,
  HOST,
  substrateOps,
  waitUntil,
} from './helpers';
import { ensureUsageSchema, readUsage, recordAwakeInterval } from '../src/usage';

const noopCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

async function signUp(): Promise<{ cookie: string; userId: string }> {
  const res = await SELF.fetch(`${HOST}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${unique('hardening')}@mari.test`,
      password: 'hardening-regression-password',
      name: 'Hardening Regression',
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toMatch(/=/);
  return { cookie, userId: body.user.id };
}

describe('tenant-scoped store and temporary credential scope', () => {
  it('derives deterministic opaque account roots and rewrites only S3 stores', async () => {
    const owner = 'oidc|person@example.test/path';
    const root = await tenantStoreRoot(owner, 'fleet/root/');
    expect(root).toMatch(/^fleet\/root\/tenants\/[0-9a-f]{64}$/);
    expect(root).not.toContain('person');
    expect(await tenantStoreRoot(owner, 'fleet/root/')).toBe(root);
    expect(await tenantStoreRoot(`${owner}-other`, 'fleet/root/')).not.toBe(root);
    expect(await tenantStoreUri('s3://mari-store/fleet/root/', owner)).toBe(
      `s3://mari-store/${root}`,
    );
    expect(await tenantStoreUri('fs:///var/lib/mari', owner)).toBe('fs:///var/lib/mari');
  });

  it('keeps shared prefixes inside one tenant and grants heat as one exact object', async () => {
    const root = await tenantStoreRoot('account-a', 'operator');
    const prefixes = storeCredentialPrefixes('computerabc', root);
    const objects = storeCredentialObjects('computerabc', root);

    expect(prefixes).toEqual([
      `${root}/chunks/`,
      `${root}/manifests/`,
      `${root}/journal/computerabc/`,
      `${root}/runs/computerabc/`,
      `${root}/state/computerabc/`,
    ]);
    expect(prefixes.every((key) => key.startsWith(`${root}/`))).toBe(true);
    expect(prefixes.some((key) => key.includes('/heat/'))).toBe(false);
    expect(objects).toEqual([`${root}/heat/computerabc.cbor`]);
    expect(objects[0]).not.toMatch(/\/$/);
  });

  it('sends the heat key through Cloudflare’s exact objects field, never prefixes', async () => {
    const root = await tenantStoreRoot('account-a', 'operator');
    let requestBody: Record<string, unknown> | null = null;
    await composeStoreEnv(
      {
        STORE_URI: `s3://mari-store/${root}`,
        CF_ACCOUNT_ID: 'account',
        R2_PARENT_ACCESS_KEY_ID: 'parent',
        R2_PARENT_API_TOKEN: 'api-token',
      },
      'computerabc',
      async (_input, init) => {
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              result: {
                accessKeyId: 'temporary',
                secretAccessKey: 'temporary-secret',
                sessionToken: 'temporary-session',
              },
            }),
        };
      },
    );
    expect(requestBody).toMatchObject({
      prefixes: storeCredentialPrefixes('computerabc', root),
      objects: [`${root}/heat/computerabc.cbor`],
    });
    expect((requestBody?.['prefixes'] as string[]).some((key) => key.includes('/heat/'))).toBe(
      false,
    );
  });
});

describe('namespaced manifest bootstrap', () => {
  beforeAll(ensureSchema);

  it('copies a global base manifest and all chunks before publishing it in a tenant root', async () => {
    const text = new TextEncoder().encode('tenant base contents\n');
    const chunk = chunkIdOf(text);
    const manifest: Manifest = {
      version: 1,
      parent: null,
      created_at: 1_700_000_000,
      entries: [
        {
          path: '/README.md',
          kind: 'file',
          mode: 0o100644,
          size: text.length,
          symlink_target: null,
          chunks: [{ chunk, len: text.length }],
        },
      ],
    };
    const cbor = encodeCbor(manifest);
    const id = manifestIdOf(cbor);
    const root = await tenantStoreRoot(unique('manifest-owner'));
    await env.STORE.put(chunkKey(chunk), toArrayBuffer(encodeChunkBody(text)));
    await env.STORE.put(manifestKey(id), toArrayBuffer(cbor));

    await ensureManifestNamespace(env.STORE, id, root);
    expect(await env.STORE.head(chunkKey(chunk, root))).not.toBeNull();
    expect(await env.STORE.head(manifestKey(id, root))).not.toBeNull();

    // Once bootstrapped, the account is independently readable even if the
    // operator-authored global source is unavailable.
    await env.STORE.delete([chunkKey(chunk), manifestKey(id)]);
    const copied = await loadManifest(env.STORE, id, root);
    expect(new TextDecoder().decode(await readFile(env.STORE, copied, '/README.md', root))).toBe(
      'tenant base contents\n',
    );
  });

  it('bootstraps from the configured operator root, not the bucket root', async () => {
    const operatorRoot = `operator/${unique('base')}`;
    const tenantRoot = await tenantStoreRoot(unique('rooted-owner'), operatorRoot);
    const text = new TextEncoder().encode('rooted base\n');
    const chunk = chunkIdOf(text);
    const manifest: Manifest = {
      version: 1,
      parent: null,
      created_at: 1_700_000_001,
      entries: [
        {
          path: '/ROOTED.md',
          kind: 'file',
          mode: 0o100644,
          size: text.length,
          symlink_target: null,
          chunks: [{ chunk, len: text.length }],
        },
      ],
    };
    const cbor = encodeCbor(manifest);
    const id = manifestIdOf(cbor);
    await env.STORE.put(chunkKey(chunk, operatorRoot), toArrayBuffer(encodeChunkBody(text)));
    await env.STORE.put(manifestKey(id, operatorRoot), toArrayBuffer(cbor));

    expect(tenantStoreParentRoot(tenantRoot)).toBe(operatorRoot);
    await ensureManifestNamespace(env.STORE, id, tenantRoot);
    const copied = await loadManifest(env.STORE, id, tenantRoot);
    expect(new TextDecoder().decode(await readFile(env.STORE, copied, '/ROOTED.md', tenantRoot))).toBe(
      'rooted base\n',
    );
  });

  it('creates one deterministic empty hosted base and can publish it per tenant', async () => {
    const first = await ensureEmptyBaseManifest(env.STORE);
    const second = await ensureEmptyBaseManifest(env.STORE);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadManifest(env.STORE, first)).entries).toEqual([]);

    const root = await tenantStoreRoot(unique('empty-owner'));
    await ensureManifestNamespace(env.STORE, first, root);
    expect((await loadManifest(env.STORE, first, root)).entries).toEqual([]);
  });

  it('creates the deterministic empty base inside a configured operator root', async () => {
    const operatorRoot = `operator/${unique('empty')}`;
    const id = await ensureEmptyBaseManifest(env.STORE, operatorRoot);
    expect((await loadManifest(env.STORE, id, operatorRoot)).entries).toEqual([]);

    const tenantRoot = await tenantStoreRoot(unique('rooted-empty-owner'), operatorRoot);
    await ensureManifestNamespace(env.STORE, id, tenantRoot);
    expect((await loadManifest(env.STORE, id, tenantRoot)).entries).toEqual([]);
  });
});

describe('UTC usage intervals and lifecycle metering', () => {
  beforeAll(async () => {
    await ensureSchema();
    await ensureUsageSchema(env.DB);
  });

  it('splits half-open intervals exactly at UTC month boundaries in both ledgers', async () => {
    const startedAt = Date.UTC(2026, 0, 31, 23, 59, 59, 750);
    const endedAt = Date.UTC(2026, 1, 1, 0, 0, 0, 250);
    expect(splitUsagePeriods(startedAt, endedAt)).toEqual([
      { period: '2026-01', ms: 250 },
      { period: '2026-02', ms: 250 },
    ]);

    const userId = unique('interval-user');
    const computerId = unique('interval-computer');
    await accumulateAwakeInterval(env.DB, userId, startedAt, endedAt);
    await recordAwakeInterval(env.DB, computerId, startedAt, endedAt);
    expect((await usageFor(env.DB, userId, '2026-01')).awakeMs).toBe(250);
    expect((await usageFor(env.DB, userId, '2026-02')).awakeMs).toBe(250);
    expect((await readUsage(env.DB, computerId, '2026-01')).awakeMs).toBe(250);
    expect((await readUsage(env.DB, computerId, '2026-02')).awakeMs).toBe(250);
  });

  it('charges a real AWAKE→WARM transition to the account and computer ledgers once', async () => {
    const { cookie, userId } = await signUp();
    const computerId = await createComputer(cookie, 'metered-lifecycle');
    const stub = computerStub(computerId);
    await stub.wake(computerId);
    await delay(30);
    await stub.sleepNow();

    await waitUntil(
      async () =>
        (await usageFor(env.DB, userId, currentPeriod())).awakeMs > 0 &&
        (await readUsage(env.DB, computerId, currentPeriod())).awakeMs > 0,
      3000,
      'awake interval ledgers',
    );
    const account = (await usageFor(env.DB, userId, currentPeriod())).awakeMs;
    const computer = (await readUsage(env.DB, computerId, currentPeriod())).awakeMs;
    expect(account).toBeGreaterThan(0);
    expect(computer).toBe(account);

    // Closing an already-closed stretch must not double-charge.
    await stub.sleepNow();
    await delay(25);
    expect((await usageFor(env.DB, userId, currentPeriod())).awakeMs).toBe(account);
    expect((await readUsage(env.DB, computerId, currentPeriod())).awakeMs).toBe(computer);
  });
});

describe('atomic fleet caps', () => {
  beforeAll(ensureSchema);

  it('allows exactly one winner when concurrent inserts race for the final slot', async () => {
    const userId = unique('cap-user');
    const [a, b] = await Promise.all([
      insertComputerWithinLimit(
        env.DB,
        { id: unique('cap-a'), name: 'A', userId },
        1,
      ),
      insertComputerWithinLimit(
        env.DB,
        { id: unique('cap-b'), name: 'B', userId },
        1,
      ),
    ]);
    expect([a, b].filter((row) => row !== null)).toHaveLength(1);
    const count = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM computers WHERE userId = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(Number(count?.n)).toBe(1);
    await expect(
      insertComputerWithinLimit(
        env.DB,
        { id: unique('cap-c'), name: 'C', userId },
        1,
      ),
    ).resolves.toBeNull();
  });
});

describe('permanent computer delete', () => {
  beforeAll(ensureSchema);

  it('destroys the substrate, removes mutable R2/D1 content, and retains shared objects', async () => {
    const { cookie } = await signUp();
    const computerId = await createComputer(cookie, 'delete-me');
    const sibling = await createComputer(cookie, 'lineage-sibling');
    await env.DB
      .prepare('INSERT INTO lineage (child, parent, at) VALUES (?, ?, ?)')
      .bind(sibling, computerId, Date.now())
      .run();
    await env.DB
      .prepare('INSERT INTO secrets (computerId, name, value) VALUES (?, ?, ?)')
      .bind(computerId, 'DELETE_TEST_SECRET', 'must-disappear')
      .run();
    await recordAwakeInterval(env.DB, computerId, Date.now() - 100, Date.now());

    const mutableKeys = [
      `journal/${computerId}/0001.cbor`,
      `runs/${computerId}/run-1.cbor`,
      `state/${computerId}/head.cbor`,
      `heat/${computerId}.cbor`,
    ];
    for (const key of mutableKeys) await env.STORE.put(key, 'private');
    const shared = `chunks/${unique('retained')}`;
    await env.STORE.put(shared, 'shared');

    const stub = computerStub(computerId);
    await stub.wake(computerId);
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await substrateOps(stub)).toContain('destroy');

    for (const key of mutableKeys) expect(await env.STORE.get(key)).toBeNull();
    expect(await env.STORE.get(shared)).not.toBeNull();
    expect(
      Number(
        (
          await env.DB
            .prepare('SELECT COUNT(*) AS n FROM computers WHERE id = ?')
            .bind(computerId)
            .first<{ n: number }>()
        )?.n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await env.DB
            .prepare('SELECT COUNT(*) AS n FROM secrets WHERE computerId = ?')
            .bind(computerId)
            .first<{ n: number }>()
        )?.n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await env.DB
            .prepare('SELECT COUNT(*) AS n FROM lineage WHERE child = ? OR parent = ?')
            .bind(computerId, computerId)
            .first<{ n: number }>()
        )?.n,
      ),
    ).toBe(0);
    expect((await readUsage(env.DB, computerId, currentPeriod())).awakeMs).toBe(0);
  });

  it('keeps the fleet row and mutable data retryable when teardown fails', async () => {
    const { cookie } = await signUp();
    const computerId = await createComputer(cookie, 'delete-retry');
    const stub = computerStub(computerId);
    await stub.wake(computerId);
    const journalKey = `journal/${computerId}/keep.cbor`;
    await env.STORE.put(journalKey, 'keep until destroy succeeds');
    await runInDurableObject(stub, (instance: ComputerDO) => {
      const substrate = instance.substrate as FakeSubstrate;
      substrate.destroy = async () => {
        throw new Error('provider unavailable');
      };
    });

    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'destroy_failed', retryable: true });
    expect(await env.STORE.get(journalKey)).not.toBeNull();
    const row = await env.DB
      .prepare('SELECT id FROM computers WHERE id = ?')
      .bind(computerId)
      .first<{ id: string }>();
    expect(row?.id).toBe(computerId);
  });
});

describe('preview compute gate', () => {
  beforeAll(ensureSchema);

  it('refuses an authorized preview before addressing its DO when the owner spent the cap', async () => {
    const { cookie, userId } = await signUp();
    const computerId = await createComputer(cookie, 'capped-preview');
    const preview = await SELF.fetch(
      `${HOST}/api/computers/${computerId}/preview?port=3000`,
      { headers: { Cookie: cookie } },
    );
    expect(preview.status).toBe(200);
    const info = (await preview.json()) as { host: string };
    await accumulateAwakeInterval(
      env.DB,
      userId,
      Date.now() - 2 * 3_600_000,
      Date.now(),
    );
    const before = await substrateOps(computerStub(computerId));

    const res = await handleFetch(
      new Request(`http://${info.host}/`, { headers: { Cookie: cookie } }),
      { ...env, LIMIT_COMPUTE_HOURS: '1' } as Env,
      noopCtx,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('x-mari-preview')).toBe('limit_compute');
    expect(await substrateOps(computerStub(computerId))).toEqual(before);
  });
});
