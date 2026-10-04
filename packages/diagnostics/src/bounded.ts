import { isSecretKey } from "@ace/redaction";
class Fields {
  entries: readonly (readonly [string, unknown])[];
  constructor(entries: readonly (readonly [string, unknown])[]) {
    this.entries = entries;
  }
}
/** Producer supplies a bounded field list; arbitrary objects are never enumerated by log(). */
export function logFields(entries: readonly (readonly [string, unknown])[]): object {
  return new Fields(entries);
}
function own(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : "<ACCESSOR OMITTED>";
}
function* producerFields(input: object): Iterable<readonly [string, unknown]> {
  if (!(input instanceof Fields)) return;
  const entries = own(input, "entries");
  if (!Array.isArray(entries)) return;
  for (let n = 0; n < Math.min(entries.length, 32); n++) {
    const entry = own(entries, String(n));
    if (!Array.isArray(entry)) continue;
    const key = own(entry, "0");
    if (typeof key === "string") yield [key, own(entry, "1")];
  }
}
/** Enumeration belongs only to standalone export, outside the logger's hot path. */
function* metadataFields(input: object): Iterable<readonly [string, unknown]> {
  if (input instanceof Fields) {
    yield* producerFields(input);
    return;
  }
  let count = 0;
  for (const key in input) {
    if (++count > 32) break;
    yield [key, own(input, key)];
  }
}
function normalize(
  value: unknown,
  fields: (input: object) => Iterable<readonly [string, unknown]>,
): unknown {
  let remaining = 64;
  let characters = 4096;
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 4) return "<OMITTED>";
    if (typeof input === "string") {
      if (input.length > 2048 || input.length > characters) return "<OVERSIZED>";
      characters -= input.length;
      return input;
    }
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input !== "object") return "<UNSUPPORTED>";
    if (seen.has(input)) return "<CYCLE>";
    seen.add(input);
    if (input instanceof Error)
      return { message: visit(own(input, "message"), depth + 1), name: "Error" };
    if (Array.isArray(input)) {
      const length = own(input, "length");
      if (typeof length !== "number") return "<INVALID ARRAY>";
      const result: unknown[] = [];
      for (let n = 0; n < Math.min(length, 32) && remaining > 0; n++)
        result.push(visit(own(input, String(n)), depth + 1));
      return result;
    }
    if (fields === producerFields && !(input instanceof Fields))
      return "<UNPREPARED OBJECT OMITTED>";
    const result: Record<string, unknown> = {};
    for (const [key, item] of fields(input)) {
      if (remaining <= 0) break;
      if (key.length > 128 || key.length > characters) {
        remaining--;
        Object.defineProperty(result, "<KEY>", {
          enumerable: true,
          configurable: true,
          value: "<OVERSIZED FIELD OMITTED>",
        });
        continue;
      }
      characters -= key.length;
      let cleaned: unknown = "<SECRET>";
      if (isSecretKey(key)) remaining--;
      else cleaned = visit(item, depth + 1);
      Object.defineProperty(result, key, { enumerable: true, configurable: true, value: cleaned });
    }
    return result;
  }
  try {
    return visit(value, 0);
  } catch {
    return "<NORMALIZATION FAILED: DATA OMITTED>";
  }
}
export function bounded(value: unknown): unknown {
  return normalize(value, producerFields);
}
export function boundedMetadata(value: unknown): unknown {
  return normalize(value, metadataFields);
}

/** Bounded evidence for nested external metadata; redaction precedes serialization. */
export function logMetadata(value: unknown): string {
  const json = JSON.stringify(boundedMetadata(value)) ?? "null";
  return json.length > 2000 ? json.slice(0, 1980) + "<TRUNCATED>" : json;
}
