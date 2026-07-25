/**
 * SCRATCH control plane for the Cloudflare THESIS e2e (`MARI_CF_E2E=1`,
 * `e2e/cloudflare.e2e.test.ts`).
 *
 * It is the REAL control plane: `ComputerDO`, `EventsDO` and the whole Hono app
 * are imported from `packages/control-plane/src`, never reimplemented, so the
 * container-enabled Durable Object the platform binds a container to IS
 * `ComputerDO` — which is the only way to drive spec §3.5 through the real
 * `substrates/cloudflare.ts` driver on a real Firecracker instance.
 *
 * It is deployed as `mari-thesis-e2e`, has no custom domain and no DNS record,
 * binds a scratch D1 and a scratch R2 bucket (never `mari`/`mari-store`), and is
 * deleted — worker, container application, D1, bucket — by the suite's cleanup.
 *
 * TWO test-only additions, both deliberate and both fenced:
 *
 *  1. `/__store/*` — an S3-compatible facade over the scratch R2 bucket.
 *
 *     WHY IT HAS TO EXIST: `marid` reads and writes the chunk store through
 *     opendal (`MARI_STORE=fs://…|s3://…`), and on Cloudflare there is no shared
 *     disk, so the store must be R2 over the network. Mari has no way to hand a
 *     container R2 credentials today: `ComputerDO.#maridEnv` (computer-do.ts:765) composes a
 *     FIXED set of variables (MARI_COMPUTER_ID/EPOCH/TOKEN/ROOT/STORE/
 *     CONTROL_URL/RESTORE_MANIFEST) with no seam for `AWS_*`, and R2's real S3
 *     endpoint accepts nothing else. Rather than invent a credential seam in
 *     another lane's file, this facade lets the REAL supervisor speak the REAL
 *     S3 protocol its production build will speak, against the same bucket the
 *     control plane reads manifests from — so every byte the thesis asserts
 *     still makes the full round trip through opendal, R2 and back.
 *
 *     It is decisions.md's "direct-to-R2" rule inverted (chunks transit a
 *     Worker: the memo's path (b)), which is exactly why the suite reports it as
 *     a deviation instead of hiding it.
 *
 *     Auth: every request must carry a SigV4 `Authorization` header whose access
 *     key id equals `STORE_ACCESS_KEY_ID` (minted at random per deploy). That is
 *     a bearer credential, not a verified signature — acceptable only because
 *     this Worker and its bucket live for the length of one test run and hold
 *     nothing but synthetic bytes.
 *
 *  2. `/__e2e/*` — read-only observation the REST API does not expose
 *     (container liveness as the platform sees it, and the bucket key census),
 *     plus the bucket wipe used by cleanup. Guarded by `E2E_TOKEN`.
 *
 * Nothing here weakens the control plane: the app, the DO, the driver and the
 * supervisor are untouched, and every assertion in the suite is taken from the
 * public REST/WebSocket surface unless it is explicitly labelled otherwise.
 */

import controlPlane from '../../../packages/control-plane/src/worker';
import type { Env as ControlPlaneEnv } from '../../../packages/control-plane/src/types';

export { ComputerDO } from '../../../packages/control-plane/src/computer-do';
export { EventsDO } from '../../../packages/control-plane/src/events-do';

interface Env extends ControlPlaneEnv {
  STORE: R2Bucket;
  /** Bucket name as `MARI_STORE=s3://<name>` names it (path-style addressing). */
  STORE_BUCKET: string;
  /** The access key id the container was built with. */
  STORE_ACCESS_KEY_ID: string;
  /** Token guarding `/__e2e/*`. */
  E2E_TOKEN: string;
}

const STORE_PREFIX = '/__store/';
const E2E_PREFIX = '/__e2e/';

function xml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { 'content-type': 'application/xml' },
  });
}

function s3Error(code: string, status: number, message: string): Response {
  return xml(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`, status);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The access key id out of an AWS SigV4 `Authorization` header. */
function accessKeyOf(auth: string | null): string | null {
  if (!auth) return null;
  const m = /Credential=([^/\s,]+)\//.exec(auth);
  return m ? (m[1] as string) : null;
}

function quoteEtag(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

/** `Range: bytes=a-b` → an R2 range, or undefined. */
function parseRange(header: string | null): { offset: number; length?: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd !== '') return { offset: 0, length: Number(rawEnd) };
  const offset = Number(rawStart);
  if (rawEnd === '') return { offset };
  return { offset, length: Number(rawEnd) - offset + 1 };
}

async function handleStore(request: Request, env: Env, url: URL): Promise<Response> {
  if (accessKeyOf(request.headers.get('authorization')) !== env.STORE_ACCESS_KEY_ID) {
    return s3Error('AccessDenied', 403, 'bad or missing access key id');
  }

  // Path-style addressing: /__store/{bucket}/{key…}
  const rest = url.pathname.slice(STORE_PREFIX.length);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const key = slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
  if (bucket !== env.STORE_BUCKET) return s3Error('NoSuchBucket', 404, `no bucket ${bucket}`);

  const q = url.searchParams;

  // ---- ListObjectsV2 -------------------------------------------------------
  if (request.method === 'GET' && q.get('list-type') === '2') {
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter') ?? undefined;
    const cursor = q.get('continuation-token') ?? undefined;
    const limit = Math.min(Number(q.get('max-keys') ?? '1000') || 1000, 1000);
    const listed = await env.STORE.list({ prefix, delimiter, cursor, limit });
    const contents = listed.objects
      .map(
        (o) =>
          `<Contents><Key>${esc(o.key)}</Key><LastModified>${o.uploaded.toISOString()}</LastModified>` +
          `<ETag>${esc(quoteEtag(o.httpEtag ?? o.etag))}</ETag><Size>${o.size}</Size>` +
          `<StorageClass>STANDARD</StorageClass></Contents>`,
      )
      .join('');
    const prefixes = (listed.delimitedPrefixes ?? [])
      .map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`)
      .join('');
    const truncated = listed.truncated;
    const next = truncated && 'cursor' in listed ? (listed.cursor as string) : '';
    return xml(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix>` +
        `<KeyCount>${listed.objects.length}</KeyCount><MaxKeys>${limit}</MaxKeys>` +
        (delimiter === undefined ? '' : `<Delimiter>${esc(delimiter)}</Delimiter>`) +
        `<IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>` +
        (next ? `<NextContinuationToken>${esc(next)}</NextContinuationToken>` : '') +
        contents +
        prefixes +
        `</ListBucketResult>`,
    );
  }

  // ---- DeleteObjects (POST /?delete) --------------------------------------
  if (request.method === 'POST' && q.has('delete')) {
    const body = await request.text();
    const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) =>
      (m[1] as string).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
    );
    await Promise.all(keys.map((k) => env.STORE.delete(k)));
    return xml(
      `<DeleteResult>${keys.map((k) => `<Deleted><Key>${esc(k)}</Key></Deleted>`).join('')}</DeleteResult>`,
    );
  }

  if (!key) return s3Error('InvalidRequest', 400, 'no key');

  // ---- multipart upload ----------------------------------------------------
  if (request.method === 'POST' && q.has('uploads')) {
    const mpu = await env.STORE.createMultipartUpload(key);
    return xml(
      `<InitiateMultipartUploadResult><Bucket>${esc(bucket)}</Bucket>` +
        `<Key>${esc(key)}</Key><UploadId>${esc(mpu.uploadId)}</UploadId>` +
        `</InitiateMultipartUploadResult>`,
    );
  }
  if (request.method === 'PUT' && q.has('uploadId') && q.has('partNumber')) {
    const mpu = env.STORE.resumeMultipartUpload(key, q.get('uploadId') as string);
    const part = await mpu.uploadPart(Number(q.get('partNumber')), await request.arrayBuffer());
    return new Response(null, { status: 200, headers: { etag: quoteEtag(part.etag) } });
  }
  if (request.method === 'POST' && q.has('uploadId')) {
    const mpu = env.STORE.resumeMultipartUpload(key, q.get('uploadId') as string);
    const body = await request.text();
    const parts = [...body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => {
      const chunk = m[1] as string;
      const n = /<PartNumber>(\d+)<\/PartNumber>/.exec(chunk);
      const e = /<ETag>"?([^<"]+)"?<\/ETag>/.exec(chunk);
      return { partNumber: Number(n?.[1] ?? 0), etag: (e?.[1] ?? '') as string };
    });
    const done = await mpu.complete(parts);
    return xml(
      `<CompleteMultipartUploadResult><Location>${esc(url.toString())}</Location>` +
        `<Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key>` +
        `<ETag>${esc(quoteEtag(done.httpEtag ?? done.etag))}</ETag></CompleteMultipartUploadResult>`,
    );
  }
  if (request.method === 'DELETE' && q.has('uploadId')) {
    await env.STORE.resumeMultipartUpload(key, q.get('uploadId') as string).abort();
    return new Response(null, { status: 204 });
  }

  // ---- single-object verbs -------------------------------------------------
  if (request.method === 'PUT') {
    const body = await request.arrayBuffer();
    const put = await env.STORE.put(key, body);
    return new Response(null, {
      status: 200,
      headers: { etag: quoteEtag(put?.httpEtag ?? put?.etag ?? '') },
    });
  }

  if (request.method === 'HEAD') {
    const head = await env.STORE.head(key);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 200,
      headers: {
        'content-length': String(head.size),
        etag: quoteEtag(head.httpEtag ?? head.etag),
        'last-modified': head.uploaded.toUTCString(),
      },
    });
  }

  if (request.method === 'GET') {
    const range = parseRange(request.headers.get('range'));
    const obj = await env.STORE.get(key, range ? { range } : undefined);
    if (!obj) return s3Error('NoSuchKey', 404, `no key ${key}`);
    const headers = new Headers({
      etag: quoteEtag(obj.httpEtag ?? obj.etag),
      'last-modified': obj.uploaded.toUTCString(),
      'content-length': String(obj.range && 'length' in obj.range ? obj.range.length : obj.size),
    });
    if (range) {
      const start = range.offset;
      const len = range.length ?? obj.size - start;
      headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
      return new Response(obj.body, { status: 206, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  if (request.method === 'DELETE') {
    await env.STORE.delete(key);
    return new Response(null, { status: 204 });
  }

  return s3Error('MethodNotAllowed', 405, request.method);
}

/** Constant-time-ish token compare (same shape as deploy/cf-e2e). */
function tokenOk(given: string | null, want: string): boolean {
  if (!given || !want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function handleE2e(request: Request, env: Env, url: URL): Promise<Response> {
  if (!tokenOk(request.headers.get('x-e2e-token'), env.E2E_TOKEN)) {
    return new Response('forbidden', { status: 403 });
  }
  const what = url.pathname.slice(E2E_PREFIX.length);

  // The bucket census: every key, with size. Used to assert the chunk store
  // actually holds manifests/chunks/journal segments, and by cleanup.
  if (what === 'store/list') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const keys: { key: string; size: number }[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await env.STORE.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) keys.push({ key: o.key, size: o.size });
      if (!page.truncated) break;
      cursor = (page as { cursor?: string }).cursor;
      if (!cursor) break;
    }
    return Response.json({ keys });
  }

  // ONE BATCH per call, and the caller loops. A Worker request has a subrequest
  // budget and every R2 delete spends from it, so a "delete everything" loop in
  // here dies silently part-way through and the bucket delete then fails with
  // "bucket is not empty" — which is exactly how this suite first left a bucket
  // behind. The batch size is small enough to finish well inside the budget.
  if (what === 'store/wipe' && request.method === 'POST') {
    const limit = Math.min(Number(url.searchParams.get('n') ?? '150') || 150, 500);
    const page = await env.STORE.list({ limit });
    if (page.objects.length === 0) return Response.json({ deleted: 0, done: true });
    await env.STORE.delete(page.objects.map((o) => o.key));
    return Response.json({ deleted: page.objects.length, done: false });
  }

  return new Response('not found', { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(STORE_PREFIX)) return handleStore(request, env, url);
    if (url.pathname.startsWith(E2E_PREFIX)) return handleE2e(request, env, url);
    return controlPlane.fetch(request, env, ctx);
  },
};
