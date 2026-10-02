import { isSecretKey } from "@ace/redaction";
/** Bound work before serialization or structured cloning. Never truncate a secret's prefix. */
export function bounded(value: unknown): unknown {
  let remaining = 64;
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 4) return "<OMITTED>";
    if (typeof input === "string") return input.length > 2048 ? "<OVERSIZED>" : input;
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    if (input instanceof Error)
      return { message: visit(input.message, depth + 1), name: input.name };
    if (typeof input !== "object") return String(input);
    if (seen.has(input)) return "<CYCLE>";
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 32).map((item) => visit(item, depth + 1));
    const result: Record<string, unknown> = {};
    // Do not invoke getters or enumerate an unbounded object into a temporary array.
    let count = 0;
    for (const key in input) {
      if (++count > 32 || remaining < 0) break;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && "value" in descriptor) {
        result[key.length > 128 ? "<KEY>" : key] = isSecretKey(key)
          ? "<SECRET>"
          : visit(descriptor.value, depth + 1);
      }
    }
    return result;
  }
  return visit(value, 0);
}
