import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";

/*
 * Static key pairs, apart from the hashing in `crypto.ts`: a client makes its device key when it
 * starts, while hashing is only needed once it opens a relayed channel, so a bundle that loads
 * the channel later can leave SHA-256 and HKDF out of its startup code.
 */

export type KeyPair = { privateKey: Uint8Array; publicKey: Uint8Array };
export function keyPair(privateKey: Uint8Array = randomBytes(32)): KeyPair {
  return { privateKey: privateKey.slice(), publicKey: x25519.getPublicKey(privateKey) };
}
