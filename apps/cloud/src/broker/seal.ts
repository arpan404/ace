import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase64url, encodeBase64url } from "@ace/account-grant";

/**
 * Sealing a token response to Spade's one-time X25519 key, byte for byte as Spade's
 * `spade-cloud-wire` opens it (`spade/docs/cloud.md`, "Sealing"; shared vectors in
 * `spade/crates/spade-cloud-wire/test-vectors.json`): a fresh X25519 key per answer,
 * HKDF-SHA256 (salt `spade-cloud/v1 seal`, info the sender's then the recipient's public key),
 * ChaCha20-Poly1305 with a zero nonce (each derived key seals one message) and the app and
 * purpose as associated data. Workers' Web Crypto has no ChaCha20-Poly1305, so this uses the
 * audited `@noble` libraries (MIT) ace already ships in `@ace/secure-channel`.
 */

const SALT = new TextEncoder().encode("spade-cloud/v1 seal");
const NONCE = new Uint8Array(12);

export type SealPurpose = "finish" | "refresh";
export type SealContext = { app: string; purpose: SealPurpose };
export type Sealed = { epk: string; ciphertext: string };

export class SealError extends Error {
  override name = "SealError";
}

function aad(context: SealContext): Uint8Array {
  return new TextEncoder().encode(`spade-cloud/v1 ${context.app} ${context.purpose}`);
}

/** A base64url X25519 public key, or undefined. */
export function publicKeyBytes(text: string): Uint8Array | undefined {
  try {
    const bytes = decodeBase64url(text);
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function messageKey(ours: Uint8Array, theirs: Uint8Array, sender: Uint8Array, to: Uint8Array) {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(ours, theirs);
  } catch {
    throw new SealError("not an X25519 key");
  }
  // A low-order peer key gives an all-zero secret: derive nothing from it.
  if (shared.every((byte) => byte === 0)) throw new SealError("not an X25519 key");
  const info = new Uint8Array(64);
  info.set(sender, 0);
  info.set(to, 32);
  return hkdf(sha256, shared, SALT, info, 32);
}

/**
 * Seals `plaintext` to `recipient` (base64url) with `ephemeral`, a fresh 32-byte private key the
 * caller draws from its injected randomness and never reuses.
 */
export function seal(
  recipient: string,
  plaintext: Uint8Array,
  context: SealContext,
  ephemeral: Uint8Array,
): Sealed {
  const to = publicKeyBytes(recipient);
  if (!to) throw new SealError("not an X25519 key");
  const epk = x25519.getPublicKey(ephemeral);
  const key = messageKey(ephemeral, to, epk, to);
  const ciphertext = chacha20poly1305(key, NONCE, aad(context)).encrypt(plaintext);
  return { epk: encodeBase64url(epk), ciphertext: encodeBase64url(ciphertext) };
}

/** Opens an answer sealed to `privateKey`: what Spade does. Here for tests and vectors. */
export function open(sealed: Sealed, context: SealContext, privateKey: Uint8Array): Uint8Array {
  const epk = publicKeyBytes(sealed.epk);
  if (!epk) throw new SealError("the sealed answer did not open");
  const ours = x25519.getPublicKey(privateKey);
  const key = messageKey(privateKey, epk, epk, ours);
  try {
    return chacha20poly1305(key, NONCE, aad(context)).decrypt(decodeBase64url(sealed.ciphertext));
  } catch {
    throw new SealError("the sealed answer did not open");
  }
}
