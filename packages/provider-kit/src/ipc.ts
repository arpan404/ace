export { RpcWriter } from "./rpc-writer.ts";

/** Admission before JSON.stringify: never call vendor getters or toJSON methods. */
export function boundedJson(value: unknown, maxBytes = 1_048_576): string {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  const append = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new RangeError("SDK payload exceeds byte budget");
    chunks.push(text);
  };
  const visit = (input: unknown, depth: number): void => {
    if (++nodes > 32768 || depth > 64) throw new RangeError("SDK payload exceeds structure budget");
    if (input === undefined || input === null) return append("null");
    if (typeof input === "string") {
      if (input.length > maxBytes - bytes) throw new RangeError("SDK string exceeds byte budget");
      return append(JSON.stringify(input));
    }
    if (typeof input === "boolean") return append(input ? "true" : "false");
    if (typeof input === "number" && Number.isFinite(input)) return append(String(input));
    if (typeof input !== "object") throw new TypeError("Non-JSON SDK payload");
    if (ancestors.has(input)) throw new TypeError("Cyclic SDK payload");
    ancestors.add(input);
    if (Array.isArray(input)) {
      if (input.length > 32768 - nodes) throw new RangeError("SDK array exceeds budget");
      append("[");
      for (let i = 0; i < input.length; i++) {
        if (i) append(",");
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
        if (descriptor && !("value" in descriptor)) throw new TypeError("SDK getter rejected");
        visit(descriptor?.value, depth + 1);
      }
      append("]");
    } else {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("Non-JSON SDK object");
      append("{");
      let first = true;
      // Early exit without allocating a full Object.entries array.
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        if (++nodes > 32768) throw new RangeError("SDK object exceeds budget");
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !("value" in descriptor)) throw new TypeError("SDK getter rejected");
        if (descriptor.value === undefined) continue;
        if (!first) append(",");
        first = false;
        if (key.length > maxBytes - bytes) throw new RangeError("SDK key exceeds budget");
        append(JSON.stringify(key));
        append(":");
        visit(descriptor.value, depth + 1);
      }
      append("}");
    }
    ancestors.delete(input);
  };
  visit(value, 0);
  return chunks.join("");
}
