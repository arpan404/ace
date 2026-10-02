import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { empty } from "./crypto.ts";
export const MAX_MESSAGE = 65535;
const MAX_NONCE = (1n << 64n) - 1n;
function nonceBytes(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, true);
  return nonce;
}
/** Ordered Noise CipherState. Applications must coordinate directional rekeys. */
export class CipherState {
  #key: Uint8Array | undefined;
  #nonce = 0n;
  #closed = false;
  constructor(key?: Uint8Array) {
    this.#key = key?.slice();
  }
  get hasKey(): boolean {
    return this.#key !== undefined;
  }
  #check(length: number): void {
    if (this.#closed || this.#nonce >= MAX_NONCE) {
      this.destroy();
      throw new Error("Cipher exhausted or closed");
    }
    if (length > MAX_MESSAGE) throw new Error("Noise message too large");
  }
  encrypt(plaintext: Uint8Array, ad: Uint8Array = empty): Uint8Array {
    this.#check(plaintext.length + (this.#key ? 16 : 0));
    if (!this.#key) return plaintext.slice();
    const result = chacha20poly1305(this.#key, nonceBytes(this.#nonce), ad).encrypt(plaintext);
    this.#nonce++;
    return result;
  }
  decrypt(ciphertext: Uint8Array, ad: Uint8Array = empty): Uint8Array {
    this.#check(ciphertext.length);
    if (!this.#key) return ciphertext.slice();
    const result = chacha20poly1305(this.#key, nonceBytes(this.#nonce), ad).decrypt(ciphertext);
    this.#nonce++;
    return result;
  }
  rekey(): void {
    this.#check(0);
    if (!this.#key) throw new Error("No cipher key");
    const next = chacha20poly1305(this.#key, nonceBytes(MAX_NONCE), empty)
      .encrypt(new Uint8Array(32))
      .slice(0, 32);
    this.#key.fill(0);
    this.#key = next;
  }
  destroy(): void {
    this.#key?.fill(0);
    this.#key = undefined;
    this.#closed = true;
  }
}
