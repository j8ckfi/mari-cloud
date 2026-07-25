// A SOFT WEBAUTHN AUTHENTICATOR: real ES256 keys, real CBOR, real signatures.
//
// This is not a mock of Better Auth or of @simplewebauthn/server — both run
// untouched inside the Worker and do the actual verification. What is emulated
// is the one component a headless test cannot have: the authenticator hardware.
// Every byte it produces is built to the WebAuthn spec's layout and is verified
// cryptographically on the server:
//
//   attestationObject := CBOR{ fmt: "none", attStmt: {}, authData }
//   authData          := rpIdHash(32) ‖ flags(1) ‖ signCount(4)
//                        ‖ aaguid(16) ‖ credIdLen(2) ‖ credId ‖ COSE(pubkey)
//   assertion sig     := DER( ECDSA-P256-SHA256( authData ‖ SHA256(clientData) ) )
//
// CBOR is encoded with @levischuck/tiny-cbor — the same library
// @simplewebauthn/server decodes with — because `parseAuthenticatorData`
// re-encodes the COSE key and advances its cursor by the re-encoded length, so a
// non-canonical encoder would trip "Leftover bytes detected".
//
// The DER wrapping matters too: WebAuthn EC2 signatures are ASN.1-wrapped and
// SimpleWebAuthn's `unwrapEC2Signature` parses them as such, while WebCrypto's
// `sign()` returns bare r‖s.

import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';

/** WebAuthn authenticator-data flags (spec §6.1). */
const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_BE = 0x08; // backup eligible  (a passkey: multi-device)
const FLAG_BS = 0x10; // backup state     (currently synced)
const FLAG_AT = 0x40; // attested credential data present

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
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
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf as ArrayBuffer));
}

/** Strip leading zeros, then re-add one if the top bit is set: a DER INTEGER is
 *  signed and minimally encoded. */
function derInteger(component: Uint8Array): Uint8Array {
  let start = 0;
  while (start < component.length - 1 && component[start] === 0) start++;
  const body = component.subarray(start);
  const needsPad = (body[0]! & 0x80) !== 0;
  const len = body.length + (needsPad ? 1 : 0);
  const out = new Uint8Array(2 + len);
  out[0] = 0x02; // INTEGER
  out[1] = len;
  if (needsPad) out[2] = 0x00;
  out.set(body, 2 + (needsPad ? 1 : 0));
  return out;
}

/** WebCrypto ECDSA yields raw r‖s (64 bytes for P-256); WebAuthn carries
 *  `SEQUENCE { INTEGER r, INTEGER s }`. */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const r = derInteger(raw.subarray(0, half));
  const s = derInteger(raw.subarray(half));
  const body = concatBytes(r, s);
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

/** The COSE_Key form of a P-256 public key: kty=EC2(2), alg=ES256(-7),
 *  crv=P-256(1), x, y. */
function coseKeyFromRawPublic(raw: Uint8Array): Uint8Array {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error(`expected an uncompressed P-256 point, got ${raw.length} bytes`);
  }
  const map = new Map<number, CBORType>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, raw.subarray(1, 33)],
    [-3, raw.subarray(33, 65)],
  ]);
  return encodeCBOR(map as CBORType);
}

/** What a browser hands `navigator.credentials.create()` back as. */
export interface RegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform';
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
}

/** What a browser hands `navigator.credentials.get()` back as. */
export interface AuthenticationResponse {
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
}

/**
 * One credential living on one emulated device. Created by
 * `SoftAuthenticator.register`, reused for as many assertions as the test wants
 * (its signature counter increments exactly as real hardware's does).
 */
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
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    return new SoftCredential(credentialId, rpId, userHandle, keyPair);
  }

  async #authData(flags: number, attested: Uint8Array | null): Promise<Uint8Array> {
    const rpIdHash = await sha256(new TextEncoder().encode(this.rpId));
    const head = concatBytes(rpIdHash, new Uint8Array([flags]), u32(this.#signCount));
    return attested ? concatBytes(head, attested) : head;
  }

  /** The attestation half of a registration ceremony (`attestation: "none"`). */
  async attest(challenge: string, origin: string): Promise<RegistrationResponse> {
    const rawPublic = new Uint8Array(
      await crypto.subtle.exportKey('raw', this.keyPair.publicKey),
    );
    const attestedCredentialData = concatBytes(
      new Uint8Array(16), // all-zero AAGUID, as privacy-preserving platforms report
      u16(this.credentialId.length),
      this.credentialId,
      coseKeyFromRawPublic(rawPublic),
    );
    const authData = await this.#authData(
      FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT,
      attestedCredentialData,
    );
    const attestationObject = encodeCBOR(
      new Map<string, CBORType>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, CBORType>()],
        ['authData', authData],
      ]) as CBORType,
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

  /** The assertion half of a sign-in ceremony. Increments the signature counter
   *  first, exactly as hardware does — a replayed count is a cloned key. */
  async assert(
    challenge: string,
    origin: string,
    opts: { type?: string; signCount?: number } = {},
  ): Promise<AuthenticationResponse> {
    this.#signCount = opts.signCount ?? this.#signCount + 1;
    const authData = await this.#authData(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS, null);
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: opts.type ?? 'webauthn.get',
        challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const signedOver = concatBytes(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign(
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
