// Preview access control (spec 8.5 "Browser, preview mode" + spec 10).
//
// A preview host is `{port}--{computer}--{user}.<zone>` (decisions.md: ONE DNS
// label, because a wildcard cert covers one level). The wake proxy that serves
// it is the ONE edge surface that both reads a computer's ports and MATERIALIZES
// substrate resources on a bare GET, so it needs an authorization decision of
// its own — before the request reaches the computer's Durable Object.
//
// It used to have none: `tryWakeProxy` parsed the host, threw the `user` field
// away and forwarded straight to the DO. Anyone who knew (or guessed) a computer
// id could read any port it had published, and — on a COLD computer — could make
// Mari materialize a stranger's computer with an unauthenticated request, over
// and over. That is a cross-tenant read and a denial-of-wallet in one route.
//
// Two things fix it, and both live here so the rules are testable in isolation:
//
//  1. **The user label is verified, not decorative.** It is a deterministic,
//     opaque function of the OWNER's user id, so a host whose label does not
//     match the computer's owner is refused without a substrate call. It is a
//     hash rather than the user id itself: a preview hostname ends up in DNS
//     logs, referrers and screenshots, and the account identifier does not
//     belong there.
//  2. **A scoped, expiring capability.** `GET /api/computers/:id/preview?port=`
//     (session-authenticated, ownership-scoped) mints an HMAC token bound to
//     THAT computer and THAT port. The proxy accepts it from the `mari_preview`
//     cookie or once from the query string (which it then converts into the
//     cookie and redirects away, so the token does not linger in the iframe's
//     address bar). A session cookie that owns the computer is accepted too, for
//     an operator with `curl` and for deployments that scope the session cookie
//     to the whole zone.
//
// Everything is Web Crypto only, so it runs unchanged on workerd and on Node.

/** Query parameter the minted URL carries the capability in. */
export const PREVIEW_TOKEN_PARAM = 'mari_preview';

/** Cookie the proxy stores the capability in, per preview host. */
export const PREVIEW_COOKIE = 'mari_preview';

/** Default lifetime of a preview capability. Long enough for a working session,
 *  short enough that a leaked URL is not a permanent grant. */
export const PREVIEW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return hex(new Uint8Array(sig));
}

/** Length-independent, value-independent comparison of two hex digests. */
function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The `user` field of this owner's preview hosts: 12 hex characters of
 * SHA-256(userId).
 *
 * Stable (so the URL is stable, spec 8.5), a valid DNS label field (`[a-z0-9]+`,
 * which is what the proxy's parser enforces), and opaque — the account id never
 * appears in a hostname.
 */
export async function previewUserLabel(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`mari-preview-user:${userId}`));
  return hex(new Uint8Array(digest)).slice(0, 12);
}

function tokenPayload(computer: string, port: number, expiresAt: number): string {
  return `p1:${computer}:${port}:${expiresAt}`;
}

/** Mint a capability for one computer + one port, expiring at `expiresAt`. */
export async function mintPreviewToken(
  secret: string,
  computer: string,
  port: number,
  expiresAt: number,
): Promise<string> {
  const sig = await hmacHex(secret, tokenPayload(computer, port, expiresAt));
  return `p1.${expiresAt}.${sig}`;
}

/**
 * Verify a capability against a computer + port. Returns false for a malformed
 * token, a wrong signature, a token minted for a different computer or port, and
 * an expired one — never throws, so a hostile cookie cannot 500 the proxy.
 */
export async function verifyPreviewToken(
  secret: string,
  token: string | null | undefined,
  computer: string,
  port: number,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'p1') return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expected = await hmacHex(secret, tokenPayload(computer, port, expiresAt));
  return digestEquals(expected, String(parts[2]));
}

/** Read one cookie value from a request's `Cookie` header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** How a BROWSER reaches this deployment's preview hosts. Derived from the same
 *  `BASE_URL` the app is served on, so an operator configures one origin, not
 *  three (the web app used to hardcode `https` and a build-time zone). */
export function previewOrigin(
  zone: string,
  baseUrl: string | undefined,
): { scheme: 'http' | 'https'; port: string } {
  try {
    const url = new URL(baseUrl ?? 'http://localhost');
    return { scheme: url.protocol === 'https:' ? 'https' : 'http', port: url.port };
  } catch {
    void zone;
    return { scheme: 'http', port: '' };
  }
}

/** The full preview URL for a port: `{scheme}://{port}--{computer}--{user}.{zone}[:{port}]/`. */
export function previewUrlFor(input: {
  zone: string;
  baseUrl: string | undefined;
  port: number;
  computer: string;
  user: string;
  token?: string | null;
}): { host: string; url: string } {
  const { scheme, port: originPort } = previewOrigin(input.zone, input.baseUrl);
  const host = `${input.port}--${input.computer}--${input.user}.${input.zone}`;
  const authority = originPort === '' ? host : `${host}:${originPort}`;
  const query = input.token ? `?${PREVIEW_TOKEN_PARAM}=${encodeURIComponent(input.token)}` : '';
  return { host, url: `${scheme}://${authority}/${query}` };
}
