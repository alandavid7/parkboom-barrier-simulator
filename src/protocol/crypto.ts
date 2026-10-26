// P-256 ECDSA signing behind a small interface.
// In the simulator keys live in memory. In production:
//   - the cloud's Signer wraps an AWS KMS key (the private key never leaves KMS);
//   - the phone's Signer wraps a Secure Enclave key, generated on the device and never exportable;
//   - the barrier's Signer wraps a key generated in the chip's protected storage at manufacture.
// Everything else in the protocol only sees this interface.
//
// Signature format: WebCrypto returns raw r||s (64 bytes, IEEE P1363). iOS and KMS return DER.
// Production code converts DER to raw at the edge so the wire format stays one thing.

import { canonicalJson, fromB64u, toB64u, utf8 } from './encoding.js';

export interface Signer {
  readonly keyId: string;
  /** Public key as base64url of the uncompressed point (65 bytes). */
  publicKey(): Promise<string>;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export class MemorySigner implements Signer {
  private constructor(readonly keyId: string, private readonly pair: CryptoKeyPair) {}

  static async generate(keyId: string): Promise<MemorySigner> {
    const pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
    return new MemorySigner(keyId, pair);
  }

  async publicKey(): Promise<string> {
    const raw = await crypto.subtle.exportKey('raw', this.pair.publicKey);
    return toB64u(new Uint8Array(raw));
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign(SIGN, this.pair.privateKey, data));
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importPublic(publicKeyB64u: string): Promise<CryptoKey> {
  let key = keyCache.get(publicKeyB64u);
  if (!key) {
    key = crypto.subtle.importKey('raw', fromB64u(publicKeyB64u), ALG, false, ['verify']);
    keyCache.set(publicKeyB64u, key);
  }
  return key;
}

export async function verify(publicKeyB64u: string, data: Uint8Array, signatureB64u: string): Promise<boolean> {
  try {
    const key = await importPublic(publicKeyB64u);
    return await crypto.subtle.verify(SIGN, key, fromB64u(signatureB64u), data);
  } catch {
    return false;
  }
}

/** A payload plus the signature over its canonical encoding. */
export interface Signed<T> { payload: T; sig: string; keyId: string }

export async function signPayload<T>(signer: Signer, payload: T): Promise<Signed<T>> {
  const sig = await signer.sign(utf8(canonicalJson(payload)));
  return { payload, sig: toB64u(sig), keyId: signer.keyId };
}

export function verifyPayload<T>(publicKeyB64u: string, signed: Signed<T>): Promise<boolean> {
  return verify(publicKeyB64u, utf8(canonicalJson(signed.payload)), signed.sig);
}
