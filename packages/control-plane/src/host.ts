// Wake-proxy host parsing (spec 8.5 browser preview mode, decisions.md).
//
// Preview hostnames are ONE label under the zone: `{port}--{computer}--{user}`,
// e.g. `8080--abc123--alice.mari.sh`. A `*.mari.sh` wildcard cert covers exactly
// one label level, so the port/computer/user triple is packed into a single
// label separated by `--` — never dots. This module is deliberately dependency-
// free and pure so the parsing is unit-testable against adversarial hosts.

/** A parsed preview host: which port of which computer for which user. */
export interface PreviewTarget {
  port: number;
  computer: string;
  user: string;
}

/** The `--` separator packing three fields into one DNS label. */
const SEP = '--';

/** A single DNS label allows [a-z0-9-] but our fields must not themselves
 *  contain `--` (the separator) or `.` (would escape the label). Field ids are
 *  produced by us as lowercase alphanumerics; keep the guard strict. */
const FIELD_RE = /^[a-z0-9]+$/;

/**
 * Parse a request `Host` header against the preview `zone`. Returns the target
 * for a valid `{port}--{computer}--{user}.<zone>` host, or `null` for anything
 * else (including plain API hosts, which must fall through to the REST app).
 *
 * Strict by construction:
 *  - the host must end in exactly `.<zone>` (case-insensitive on the zone);
 *  - exactly ONE label precedes the zone (no nested subdomains);
 *  - that label splits on `--` into EXACTLY three non-empty fields;
 *  - `port` is a base-10 integer in 1..65535 with no leading zeros/sign;
 *  - `computer` and `user` match `[a-z0-9]+`.
 */
export function parsePreviewHost(
  hostHeader: string | null | undefined,
  zone: string,
): PreviewTarget | null {
  if (!hostHeader || !zone) return null;

  // Strip an optional port on the Host header itself (`example:8787`).
  let host = hostHeader.trim().toLowerCase();
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  if (host.length === 0) return null;

  const suffix = '.' + zone.trim().toLowerCase();
  if (!host.endsWith(suffix)) return null;

  const label = host.slice(0, host.length - suffix.length);
  // Exactly one label before the zone: it must contain no dot.
  if (label.length === 0 || label.includes('.')) return null;

  const parts = label.split(SEP);
  if (parts.length !== 3) return null;
  const [portStr, computer, user] = parts as [string, string, string];

  if (!FIELD_RE.test(computer) || !FIELD_RE.test(user)) return null;

  // Port: digits only, no leading zero (unless the single char '0', which is out
  // of range anyway), within 1..65535.
  if (!/^[1-9][0-9]{0,4}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { port, computer, user };
}
