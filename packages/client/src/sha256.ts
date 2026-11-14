/*
 * SHA-256 (FIPS 180-4) fed in parts, for a file sent from a device that never holds it whole:
 * an upload names its hash before the first byte goes, so the bytes are hashed as they are read
 * and read again to send. Pure and dependency-free (the iPhone bridge has no Web Crypto
 * streaming digest); work per part is proportional to the part.
 */

const k = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotate = (value: number, by: number) => (value >>> by) | (value << (32 - by));

export class Sha256 {
  #hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  #words = new Uint32Array(64);
  /** The bytes of a block not yet full. */
  #block = new Uint8Array(64);
  #filled = 0;
  #length = 0;
  #done = false;

  /** Hash the next part. */
  update(bytes: Uint8Array): this {
    if (this.#done) throw new Error("sha256: already finished");
    this.#length += bytes.length;
    let at = 0;
    if (this.#filled > 0) {
      const take = Math.min(64 - this.#filled, bytes.length);
      this.#block.set(bytes.subarray(0, take), this.#filled);
      this.#filled += take;
      at = take;
      if (this.#filled < 64) return this;
      this.#compress(this.#block, 0);
      this.#filled = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.#compress(bytes, at);
    this.#block.set(bytes.subarray(at), 0);
    this.#filled = bytes.length - at;
    return this;
  }

  /** The hash of every part, as lowercase hex. No part can follow. */
  hex(): string {
    if (this.#done) throw new Error("sha256: already finished");
    const bits = this.#length * 8;
    const tail = new Uint8Array(this.#filled + 9 > 64 ? 128 : 64);
    tail.set(this.#block.subarray(0, this.#filled));
    tail[this.#filled] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.#compress(tail, at);
    this.#done = true;
    return [...this.#hash].map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  #compress(bytes: Uint8Array, at: number): void {
    const w = this.#words;
    for (let i = 0; i < 16; i++) {
      const o = at + i * 4;
      w[i] =
        (((bytes[o] ?? 0) << 24) |
          ((bytes[o + 1] ?? 0) << 16) |
          ((bytes[o + 2] ?? 0) << 8) |
          (bytes[o + 3] ?? 0)) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    const h = this.#hash;
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + choose + (k[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] ?? 0) + a;
    h[1] = (h[1] ?? 0) + b;
    h[2] = (h[2] ?? 0) + c;
    h[3] = (h[3] ?? 0) + d;
    h[4] = (h[4] ?? 0) + e;
    h[5] = (h[5] ?? 0) + f;
    h[6] = (h[6] ?? 0) + g;
    h[7] = (h[7] ?? 0) + hh;
  }
}
