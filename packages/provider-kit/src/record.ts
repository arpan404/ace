/**
 * Read a decoded provider value as a JSON object without copying it. Translators read native
 * fields through this on every frame, often many times per frame, so it must not copy (a zod
 * record parse copies every key). The value is returned as is: provider frame data is frozen by
 * ProviderPayload, and the type is read-only so nothing writes through it.
 */
export type NativeRecord = Readonly<Record<string, unknown>>;

const empty: NativeRecord = Object.freeze({});

/** The same plain objects zod's record accepts: arrays, class instances and primitives are not. */
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
