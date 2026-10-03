/** Bounded, descriptor-only JSON traversal. Large strings are never serialized whole. */
export function* jsonPieces(
  value: unknown,
  strings: (text: string, field?: string) => Iterable<string>,
  maxBytes = 16777216,
  redact: (field: string, value: unknown) => boolean = () => false,
): Generator<string> {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  function* out(text: string): Generator<string> {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error("SDK raw body exceeds streaming budget");
    yield text;
  }
  function* visit(input: unknown, depth: number, field?: string): Generator<string> {
    if (++nodes > 32768 || depth > 64) throw new Error("SDK raw structure exceeds budget");
    if (field && redact(field, input)) {
      yield* out('"<SECRET>"');
      return;
    }
    if (input === null || input === undefined) {
      yield* out("null");
      return;
    }
    if (typeof input === "string") {
      yield* out('"');
      for (const piece of strings(input, field)) yield* out(JSON.stringify(piece).slice(1, -1));
      yield* out('"');
      return;
    }
    if (typeof input === "boolean" || (typeof input === "number" && Number.isFinite(input))) {
      yield* out(String(input));
      return;
    }
    if (typeof input !== "object" || ancestors.has(input))
      throw new Error("Non-JSON SDK raw value");
    const array = Array.isArray(input);
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      throw new Error("Non-JSON SDK raw object");
    ancestors.add(input);
    yield* out(array ? "[" : "{");
    let first = true;
    const entries = function* () {
      if (Array.isArray(input)) {
        if (input.length > 32768) throw new Error("SDK raw array exceeds budget");
        for (let i = 0; i < input.length; i++) yield String(i);
      } else for (const key in input) if (Object.hasOwn(input, key)) yield key;
    };
    for (const key of entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && !("value" in descriptor)) throw new Error("SDK getter rejected");
      if (!array && descriptor?.value === undefined) continue;
      if (!first) yield* out(",");
      first = false;
      if (!array) {
        if (key.length > 1024) throw new Error("SDK raw key exceeds budget");
        yield* out(JSON.stringify(key));
        yield* out(":");
      }
      yield* visit(descriptor?.value, depth + 1, key);
    }
    yield* out(array ? "]" : "}");
    ancestors.delete(input);
  }
  yield* visit(value, 0);
}
