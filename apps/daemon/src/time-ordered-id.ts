import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562 §5.7): a 48-bit Unix millisecond timestamp, the version, 12 bits we use
 * as a counter, the variant, then 62 random bits. As database keys they land next to each
 * other in every index instead of on a random page, so an insert dirties far fewer pages.
 *
 * One generator's ids strictly increase: within a millisecond the counter advances, and a
 * clock that steps back (or a full counter) keeps counting from the last timestamp used.
 */
export function timeOrderedIds(
  now: () => number = Date.now,
  random: (bytes: number) => Uint8Array = randomBytes,
): () => string {
  let lastMs = -1;
  let counter = 0;
  return () => {
    const clock = Math.floor(now());
    if (clock > lastMs) {
      lastMs = clock;
      // A random start within the lower half leaves room to count up in the same millisecond.
      const seed = random(2);
      counter = (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & 0x7ff;
    } else if (++counter > 0xfff) {
      lastMs++;
      counter = 0;
    }
    return formatUuidV7(lastMs, counter, random(8));
  };
}

/** Lays out one UUIDv7 from its timestamp, its 12-bit counter and 8 random bytes. */
export function formatUuidV7(ms: number, counter: number, tail: Uint8Array): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= 2 ** 48) throw new Error("Invalid timestamp");
  const bytes = new Uint8Array(16);
  for (let index = 5, rest = ms; index >= 0; index--, rest = Math.floor(rest / 256))
    bytes[index] = rest % 256;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((tail[0] ?? 0) & 0x3f);
  for (let index = 1; index < 8; index++) bytes[8 + index] = tail[index] ?? 0;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
