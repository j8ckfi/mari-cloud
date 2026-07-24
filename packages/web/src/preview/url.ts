// Preview host/URL builder for browser-preview panes (spec 8.5 "Browser,
// preview mode": a stable URL per port per computer).
//
// decisions.md locks the hostname shape to ONE DNS label under the zone:
//   {port}--{computer}--{user}.mari.sh
// because a `*.mari.sh` wildcard cert covers exactly one label level. The three
// fields are joined by a `--` separator, so no field may itself contain `--`,
// and the whole left-hand label must be a valid DNS label (<= 63 chars, LDH,
// not starting/ending with a hyphen). This builder and its parser are the exact
// mirror of the control-plane wake proxy, kept honest by round-trip tests.

/** The default hosted zone. Private instances override this. */
export const DEFAULT_ZONE = 'mari.sh';

/** The field separator inside the single preview label. */
export const SEP = '--';

export interface PreviewParts {
  port: number;
  computer: string;
  user: string;
}

/** Thrown when a preview host cannot be built or parsed. */
export class PreviewHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewHostError';
  }
}

const MAX_LABEL_LEN = 63;
// A single DNS-label field: LDH, not starting/ending with a hyphen, and never
// containing the `--` separator.
const FIELD_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function assertField(value: string, name: string): void {
  if (value.length === 0) throw new PreviewHostError(`${name} must not be empty`);
  if (!FIELD_RE.test(value)) {
    throw new PreviewHostError(
      `${name} "${value}" is not a valid DNS label field (lowercase letters, digits, single hyphens)`,
    );
  }
  if (value.includes(SEP)) {
    throw new PreviewHostError(`${name} "${value}" must not contain the "${SEP}" separator`);
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PreviewHostError(`port must be an integer in 1..65535, got ${port}`);
  }
}

/** Build the single preview label `{port}--{computer}--{user}` (no zone). */
export function previewLabel(parts: PreviewParts): string {
  assertPort(parts.port);
  assertField(parts.computer, 'computer');
  assertField(parts.user, 'user');
  const label = `${parts.port}${SEP}${parts.computer}${SEP}${parts.user}`;
  if (label.length > MAX_LABEL_LEN) {
    throw new PreviewHostError(
      `preview label "${label}" is ${label.length} chars, exceeds DNS limit ${MAX_LABEL_LEN}`,
    );
  }
  return label;
}

/** Build the full preview host `{port}--{computer}--{user}.{zone}`. */
export function previewHost(parts: PreviewParts, zone = DEFAULT_ZONE): string {
  return `${previewLabel(parts)}.${zone}`;
}

/** Build the full preview URL (https), optionally with a path. */
export function previewUrl(parts: PreviewParts, zone = DEFAULT_ZONE, path = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `https://${previewHost(parts, zone)}${p}`;
}

/**
 * Parse a preview host back into its parts. Accepts a bare host or a full URL.
 * The zone is whatever follows the first label; the first label must contain
 * exactly the three `--`-separated fields. Throws on any malformed input.
 */
export function parsePreviewHost(input: string): PreviewParts & { zone: string } {
  let host = input;
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      throw new PreviewHostError(`not a valid URL: ${input}`);
    }
  }
  const dot = host.indexOf('.');
  if (dot < 0) throw new PreviewHostError(`host "${host}" has no zone`);
  const label = host.slice(0, dot);
  const zone = host.slice(dot + 1);
  if (zone.length === 0) throw new PreviewHostError(`host "${host}" has an empty zone`);

  const fields = label.split(SEP);
  if (fields.length !== 3) {
    throw new PreviewHostError(
      `preview label "${label}" must have exactly 3 "${SEP}"-separated fields, got ${fields.length}`,
    );
  }
  const [portStr, computer, user] = fields as [string, string, string];
  const port = Number(portStr);
  assertPort(port);
  assertField(computer, 'computer');
  assertField(user, 'user');
  return { port, computer, user, zone };
}
