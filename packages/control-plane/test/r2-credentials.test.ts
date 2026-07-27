import { describe, expect, it, vi } from 'vitest';
import {
  composeStoreEnv,
  storeCredentialObjects,
  storeCredentialPrefixes,
  tenantStoreParentRoot,
  tenantStoreRoot,
  tenantStoreUri,
  tempCredentialTtlSeconds,
  StoreCredentialError,
} from '../src/r2-credentials';

function okFetch(calls: unknown[]) {
  return vi.fn(async (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    calls.push({ input, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          result: {
            accessKeyId: 'tmp-key',
            secretAccessKey: 'tmp-secret',
            sessionToken: 'tmp-session',
          },
        }),
    };
  });
}

describe('R2 materialize credentials', () => {
  const tenantRoot = `root/tenants/${'a'.repeat(64)}`;
  it('does nothing for filesystem stores', async () => {
    await expect(composeStoreEnv({ STORE_URI: 'fs:///store' }, 'c1')).resolves.toEqual({});
    await expect(composeStoreEnv({}, 'c1')).resolves.toEqual({});
  });

  it('mints short-lived per-computer credentials for s3 stores', async () => {
    const calls: unknown[] = [];
    const env = await composeStoreEnv(
      {
        STORE_URI: `s3://mari-store/${tenantRoot}`,
        CF_ACCOUNT_ID: 'acct123',
        R2_PARENT_ACCESS_KEY_ID: 'parent-key',
        R2_PARENT_API_TOKEN: 'parent-token',
        R2_TEMP_TTL_SECONDS: '1200',
      },
      'computer-a',
      okFetch(calls),
    );

    expect(env).toEqual({
      AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com',
      AWS_REGION: 'auto',
      AWS_ACCESS_KEY_ID: 'tmp-key',
      AWS_SECRET_ACCESS_KEY: 'tmp-secret',
      AWS_SESSION_TOKEN: 'tmp-session',
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: string; init: { headers: Record<string, string>; body: string } };
    expect(call.input).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/r2/temp-access-credentials');
    expect(call.init.headers.authorization).toBe('Bearer parent-token');
    expect(JSON.parse(call.init.body)).toMatchObject({
      bucket: 'mari-store',
      parentAccessKeyId: 'parent-key',
      permission: 'object-read-write',
      ttlSeconds: 1200,
      prefixes: storeCredentialPrefixes('computer-a', tenantRoot),
      objects: storeCredentialObjects('computer-a', tenantRoot),
    });
  });

  it('uses a loud static fallback only when temporary credentials are unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = await composeStoreEnv(
      {
        STORE_URI: 's3://mari-store',
        CF_ACCOUNT_ID: 'acct123',
        R2_ACCESS_KEY_ID: 'static-key',
        R2_SECRET_ACCESS_KEY: 'static-secret',
        ALLOW_STATIC_R2_CREDENTIALS: '1',
      },
      'computer-a',
    );
    expect(env).toMatchObject({
      AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com',
      AWS_ACCESS_KEY_ID: 'static-key',
      AWS_SECRET_ACCESS_KEY: 'static-secret',
    });
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STATIC R2 credentials injected'));
    warn.mockRestore();
  });

  it('fails before materialize when an s3 store has no endpoint or credentials', async () => {
    await expect(composeStoreEnv({ STORE_URI: 's3://mari-store' }, 'c1')).rejects.toThrow(
      /no S3 endpoint/,
    );
    await expect(
      composeStoreEnv({ STORE_URI: 's3://mari-store', CF_ACCOUNT_ID: 'acct123' }, 'c1'),
    ).rejects.toThrow(/no R2 credentials/);
  });

  it('scopes shared data to an account root and mutable data to one computer', async () => {
    expect(storeCredentialPrefixes('abc')).toEqual([
      'chunks/',
      'manifests/',
      'journal/abc/',
      'runs/abc/',
      'state/abc/',
    ]);
    expect(storeCredentialObjects('abc')).toEqual(['heat/abc.cbor']);
    const a = await tenantStoreRoot('auth0|account-a', 'root');
    const b = await tenantStoreRoot('auth0|account-b', 'root');
    expect(a).toMatch(/^root\/tenants\/[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(tenantStoreParentRoot(a)).toBe('root');
    expect(tenantStoreParentRoot(`tenants/${'f'.repeat(64)}`)).toBe('');
    expect(tenantStoreParentRoot('root/not-a-tenant')).toBeNull();
    await expect(tenantStoreUri('s3://mari-store/root', 'auth0|account-a')).resolves.toBe(
      `s3://mari-store/${a}`,
    );
    expect(() => storeCredentialPrefixes('../abc')).toThrow(StoreCredentialError);
    expect(tempCredentialTtlSeconds({ R2_TEMP_TTL_SECONDS: '1' })).toBe(900);
    expect(tempCredentialTtlSeconds({ R2_TEMP_TTL_SECONDS: '99999999' })).toBe(604800);
  });

  it('refuses bucket-wide static credentials unless explicitly enabled for development', async () => {
    await expect(
      composeStoreEnv(
        {
          STORE_URI: 's3://mari-store',
          CF_ACCOUNT_ID: 'acct123',
          R2_ACCESS_KEY_ID: 'static-key',
          R2_SECRET_ACCESS_KEY: 'static-secret',
        },
        'computer-a',
      ),
    ).rejects.toThrow(/development-only/);
  });
});
