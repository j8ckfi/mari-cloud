// A SOFT WEBAUTHN AUTHENTICATOR for the Cloudflare thesis e2e.
//
// The hosted control plane treats any public TLS origin as production (auth.ts),
// and production auth is passkeys only — so a test that drives the REST API on a
// workers.dev origin has to perform a real WebAuthn ceremony. Better Auth, its
// passkey plugin and @simplewebauthn/server all run untouched inside the Worker
// and verify every byte below cryptographically; the only emulated component is
// the authenticator device.
//
//   attestationObject := CBOR{ fmt: "none", attStmt: {}, authData }
//   authData          := rpIdHash(32) ‖ flags(1) ‖ signCount(4)
//                        ‖ aaguid(16) ‖ credIdLen(2) ‖ credId ‖ COSE(pubkey)
//   assertion sig     := DER( ECDSA-P256-SHA256( authData ‖ SHA256(clientData) ) )
//
// `packages/control-plane/test/auth-soft-authenticator.ts` is the same idea in
// the control-plane lane. It is deliberately NOT imported here: that file
// typechecks under the Workers tsconfig and does not under this package's, so
// importing it would turn `pnpm --filter @mari/e2e typecheck` red. The CBOR
// encoder below is minimal and CANONICAL (definite lengths, shortest-form
// integers, insertion order preserved) because @simplewebauthn/server
// re-encodes the COSE key while parsing and rejects any length drift
// ("Leftover bytes detected").

// The GLOBAL WebCrypto, not `node:crypto`'s: this package's tsconfig carries
// both node and @cloudflare/workers-types, and the two `CryptoKey` types are not
// assignable to each other. The global is the one `CryptoKeyPair` below refers
// to, and Node provides it at runtime.
const subtle = crypto.subtle;

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_BE = 0x08; // backup eligible (a passkey is multi-device)
const FLAG_BS = 0x10; // backup state
const FLAG_AT = 0x40; // attested credential data present

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint8Array(await subtle.digest('SHA-256', buf as ArrayBuffer));
}

// ---- minimal canonical CBOR ------------------------------------------------

/** Major-type head: shortest-form argument encoding (RFC 8949 §4.2.1). */
function head(major: number, value: number): Uint8Array {
  const mt = major << 5;
  if (value < 24) return new Uint8Array([mt | value]);
  if (value < 0x100) return new Uint8Array([mt | 24, value]);
  if (value < 0x10000) return new Uint8Array([mt | 25, (value >> 8) & 0xff, value & 0xff]);
  return new Uint8Array([
    mt | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function encodeCbor(value: Cbor): Uint8Array {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -value - 1);
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(head(2, value.length), value);
  }
  const parts: Uint8Array[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(encodeCbor(k), encodeCbor(v));
  return concat(...parts);
}

/** COSE_Key for a P-256 public key: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x, y. */
function coseKey(rawPoint: Uint8Array): Uint8Array {
  if (rawPoint.length !== 65 || rawPoint[0] !== 0x04) {
    throw new Error(`expected an uncompressed P-256 point, got ${rawPoint.length} bytes`);
  }
  return encodeCbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, rawPoint.subarray(1, 33)],
      [-3, rawPoint.subarray(33, 65)],
    ]),
  );
}

/** WebCrypto ECDSA yields raw r‖s; WebAuthn carries SEQUENCE{INTEGER r, INTEGER s}. */
function derInteger(component: Uint8Array): Uint8Array {
  let start = 0;
  while (start < component.length - 1 && component[start] === 0) start++;
  const body = component.subarray(start);
  const pad = (body[0]! & 0x80) !== 0;
  const len = body.length + (pad ? 1 : 0);
  const out = new Uint8Array(2 + len);
  out[0] = 0x02;
  out[1] = len;
  if (pad) out[2] = 0;
  out.set(body, 2 + (pad ? 1 : 0));
  return out;
}

function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const body = concat(derInteger(raw.subarray(0, half)), derInteger(raw.subarray(half)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

// ---- the credential --------------------------------------------------------

export interface RegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform';
  clientExtensionResults: Record<string, never>;
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

export class SoftCredential {
  #signCount = 0;

  private constructor(
    readonly credentialId: Uint8Array,
    readonly rpId: string,
    readonly userHandle: string,
    readonly keyPair: CryptoKeyPair,
  ) {}

  get id(): string {
    return b64urlEncode(this.credentialId);
  }

  static async create(rpId: string, userHandle: string): Promise<SoftCredential> {
    const credentialId = crypto.getRandomValues(new Uint8Array(32));
    const keyPair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return new SoftCredential(credentialId, rpId, userHandle, keyPair);
  }

  async #authData(flags: number, attested: Uint8Array | null): Promise<Uint8Array> {
    const rpIdHash = await sha256(new TextEncoder().encode(this.rpId));
    const start = concat(rpIdHash, new Uint8Array([flags]), u32(this.#signCount));
    return attested ? concat(start, attested) : start;
  }

  /** The attestation half of a registration ceremony (`attestation: "none"`). */
  async attest(challenge: string, origin: string): Promise<RegistrationResponse> {
    // `exportKey` is typed `ArrayBuffer | JsonWebKey`; 'raw' always yields the
    // uncompressed point, which `coseKey` re-checks.
    const rawPublic = new Uint8Array(
      (await subtle.exportKey('raw', this.keyPair.publicKey)) as ArrayBuffer,
    );
    const attestedCredentialData = concat(
      new Uint8Array(16), // all-zero AAGUID, as privacy-preserving platforms report
      u16(this.credentialId.length),
      this.credentialId,
      coseKey(rawPublic),
    );
    const authData = await this.#authData(
      FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT,
      attestedCredentialData,
    );
    const attestationObject = encodeCbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map<Cbor, Cbor>()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        attestationObject: b64urlEncode(attestationObject),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  /** The assertion half of a sign-in ceremony (a fresh cookie jar, no username:
   *  the credential is discoverable). */
  async assert(
    challenge: string,
    origin: string,
  ): Promise<{
    id: string;
    rawId: string;
    type: 'public-key';
    authenticatorAttachment: 'platform';
    clientExtensionResults: Record<string, never>;
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle: string | null;
    };
  }> {
    this.#signCount += 1;
    const authData = await this.#authData(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS, null);
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
    );
    const signedOver = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keyPair.privateKey,
        signedOver.buffer.slice(
          signedOver.byteOffset,
          signedOver.byteOffset + signedOver.byteLength,
        ) as ArrayBuffer,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(rawSignatureToDer(raw)),
        userHandle: this.userHandle,
      },
    };
  }
}
