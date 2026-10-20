/** JSON text with object keys sorted, so `{a,b}` and `{b,a}` give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : entry,
  );
}

/**
 * Whether two values hold the same JSON facts. Key order is ignored: stored values come back
 * in schema order, so comparing raw `JSON.stringify` text reports a change that never happened.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
