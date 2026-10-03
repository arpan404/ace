/**
 * A fast, non-cryptographic key for text content: two independent 32-bit multiply-xorshift
 * lanes over UTF-16 code units, plus the length. Collisions need equal length and both lanes
 * equal, which is negligible for cache keys; it is never used for security.
 */
export function contentHash(text: string): string {
  let a = 0x811c9dc5 ^ text.length;
  let b = 0x01000193 ^ Math.imul(text.length, 0x9e3779b1);
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    a = Math.imul(a ^ unit, 0x85ebca6b);
    a ^= a >>> 15;
    b = Math.imul(b ^ unit, 0xc2b2ae35);
    b ^= b >>> 13;
  }
  a = Math.imul(a ^ (a >>> 16), 0x27d4eb2f);
  b = Math.imul(b ^ (b >>> 16), 0x165667b1);
  return `${text.length.toString(36)}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}
