/**
 * Whether two plain values (what JSON would write: strings, numbers, booleans, null, arrays and
 * objects) are the same, as their JSON would be: a field set to undefined counts as absent, and
 * key order does not matter. Strings compare by `===`, so an unchanged image still held by the
 * same string costs a pointer check, not a copy. Pure.
 */
export function samePlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!samePlain(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let count = 0;
  for (const key in left) {
    const value = left[key];
    if (value === undefined) continue;
    count++;
    if (!samePlain(value, right[key])) return false;
  }
  for (const key in right) if (right[key] !== undefined) count--;
  return count === 0;
}
