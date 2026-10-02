import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { randomBytes } from "@noble/hashes/utils.js";
export { x25519, sha256 };
export const empty = new Uint8Array();
export const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function derive(ck: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const result = hkdf(sha256, input, ck, empty, 64);
  return [result.slice(0, 32), result.slice(32)];
}
export type KeyPair = { privateKey: Uint8Array; publicKey: Uint8Array };
export function keyPair(privateKey: Uint8Array = randomBytes(32)): KeyPair {
  return { privateKey: privateKey.slice(), publicKey: x25519.getPublicKey(privateKey) };
}
export function fingerprint(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("Invalid static public key");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of sha256(publicKey)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export const hostId = fingerprint;
