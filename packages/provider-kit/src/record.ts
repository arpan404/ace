/**
 * Read a decoded provider value as a JSON object without copying it. Translators read native
 * fields through this on every frame, often many times per frame, so it must not copy (a zod
 * record parse copies every key).
 *
 * Contract: for plain JSON objects (what JSON.parse and ProviderPayload produce) it reads the
 * same fields `z.record(z.string(), z.unknown())` did. It is not that parse for anything else,
 * and does not try to be: matching zod there would need the per-call copy this exists to avoid.
 * - The value itself is returned, never a copy, typed read-only. Provider frame data is frozen
 *   by ProviderPayload; a caller that needs to change a record copies it first.
 * - Plainness is decided by prototype only: an object whose prototype is null or an
 *   Object.prototype (any realm) is returned whole, including symbol keys, non-enumerable
 *   fields and an own `__proto__` field, all of which zod's copy dropped or refused.
 * - Anything else (arrays, class instances, Maps, Dates, primitives) reads as a shared frozen
 *   empty object, even where zod would have copied the fields of an odd constructor.
 */
export type NativeRecord = Readonly<Record<string, unknown>>;

const empty: NativeRecord = Object.freeze({});

/** True for an object whose prototype is null or an Object.prototype; see the contract above. */
export function isNativeRecord(value: unknown): value is NativeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    // An object from another realm (a worker or vm context) has that realm's Object.prototype.
    (typeof prototype === "object" && Object.hasOwn(prototype, "isPrototypeOf"))
  );
}

/** The value if it is a plain object, otherwise a shared empty one. */
export function nativeRecord(value: unknown): NativeRecord {
  return isNativeRecord(value) ? value : empty;
}
