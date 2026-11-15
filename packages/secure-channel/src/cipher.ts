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
  constructor(key?: Uint8Array, initialNonce: bigint = 0n) {
    if (initialNonce < 0n || initialNonce > MAX_NONCE) throw new Error("Invalid initial nonce");
    this.#nonce = initialNonce;
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
  /**
   * A copy of the key and next nonce, for a holder that must survive losing its memory (a
   * hibernated relay). `new CipherState(key, nonce)` resumes it. Copies hold the live key.
   */
  snapshot(): { key: Uint8Array; nonce: bigint } {
    if (this.#closed || !this.#key) throw new Error("No cipher key");
    return { key: this.#key.slice(), nonce: this.#nonce };
  }
  /**
   * The relay key hand-over (docs/media/plan.md, "Key hand-over"): writes the key at `keyOffset`
   * and the next nonce, a big-endian u64, at `nonceOffset`, straight into the caller's block, then
   * destroys this state. No other copy of the key is made here; the caller wipes the block.
   */
  exportInto(block: Uint8Array, keyOffset: number, nonceOffset: number): void {
    const fits = (offset: number, length: number) =>
      Number.isInteger(offset) && offset >= 0 && offset + length <= block.length;
    if (this.#closed || !this.#key) throw new Error("No cipher key");
    if (!fits(keyOffset, 32) || !fits(nonceOffset, 8)) throw new Error("Export outside the block");
    // Checked before anything is written: an overlap would put the nonce over key bytes.
    if (keyOffset < nonceOffset + 8 && nonceOffset < keyOffset + 32)
      throw new Error("Key and nonce ranges overlap");
    block.set(this.#key, keyOffset);
    new DataView(block.buffer, block.byteOffset, block.byteLength).setBigUint64(
      nonceOffset,
      this.#nonce,
    );
    this.destroy();
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
