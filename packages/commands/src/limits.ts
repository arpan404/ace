/** Bound retained provider metadata without serializing it. Stops before traversing huge containers. */
export function dataWeight(input: unknown): number | undefined {
  let bytes = 0,
    nodes = 0;
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 16) return false;
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (value === null || typeof value === "boolean" || typeof value === "number") bytes += 8;
    else if (typeof value === "object") {
      if (seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > 4096) return false;
        for (const item of value) if (!visit(item, depth + 1)) return false;
      } else
        for (const key in value)
          if (Object.hasOwn(value, key)) {
            bytes += Buffer.byteLength(key) + 8;
            const item = Reflect.get(value, key);
            if (!visit(item, depth + 1)) return false;
          }
    } else return false;
    return bytes <= 65536;
  }
  return visit(input, 0) ? bytes : undefined;
}
