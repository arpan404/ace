import { isSecretKey } from "@ace/redaction";
import { errorSummary, ownData, stackFrames } from "./error-summary.ts";
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
class ErrorEvidence {
  error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}
/** Defer error preparation until the receiving logger supplies its redactor. */
export function logError(error: unknown): object {
  return new ErrorEvidence(error);
}
/** SQLite's extended result code, when an Error carries one, says which failure it was. */
function errcode(error: unknown): number | undefined {
  const value = error instanceof Error ? ownData(error, "errcode") : undefined;
  return typeof value === "number" ? value : undefined;
}
/** The innermost Error in a short `cause` chain: wrappers name the operation, it names why. */
function rootCause(error: unknown): Error | undefined {
  let cause: Error | undefined;
  let next = error instanceof Error ? ownData(error, "cause") : undefined;
  for (let hops = 0; hops < 4 && next instanceof Error; hops++) {
    cause = next;
    next = ownData(next, "cause");
  }
  return cause;
}
/** Flat fields only, so a nested error keeps its cause within the normalizer's depth bound. */
function preparedError(error: unknown, redact: (text: string) => string): object {
  const summary = errorSummary(error, redact);
  const cause = rootCause(error);
  const causeSummary = cause ? errorSummary(cause, redact) : undefined;
  const code = errcode(error);
  const causeCode = errcode(cause);
  const stack = stackFrames(error, redact);
  const causeStack = stackFrames(cause, redact).slice(0, 4);
  return logFields([
    ["message", summary.message],
    ...(summary.code === undefined ? [] : [["code", summary.code] as const]),
    ...(code === undefined ? [] : [["errcode", code] as const]),
    ...(summary.name === undefined ? [] : [["name", summary.name] as const]),
    ...(causeSummary ? [["cause", causeSummary.message] as const] : []),
    ...(causeSummary?.code === undefined ? [] : [["causeCode", causeSummary.code] as const]),
    ...(causeCode === undefined ? [] : [["causeErrcode", causeCode] as const]),
    ...(stack.length ? [["stack", stack] as const] : []),
    ...(causeStack.length ? [["causeStack", causeStack] as const] : []),
  ]);
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
/** A producer's own plain record (`{ code, reason }`): its own data fields, in order. */
function* plainFields(input: object): Iterable<readonly [string, unknown]> {
  const keys = Object.keys(input);
  for (let n = 0; n < Math.min(keys.length, 32); n++) {
    const key = keys[n];
    if (key !== undefined) yield [key, own(input, key)];
  }
}
function isPlainRecord(input: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
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
  redactText: (text: string) => string,
): unknown {
  let remaining = 64;
  let characters = 4096;
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 4) return "<OMITTED>";
    if (typeof input === "string") {
      if (input.length > 2048 || input.length > characters) return "<OVERSIZED>";
      characters -= input.length;
      const safe = fields === metadataFields ? redactText(input) : input;
      return safe.length > 2048 ? "<OVERSIZED>" : safe;
    }
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    // Absent stays absent: JSON drops the field rather than recording a placeholder.
    if (input === undefined) return undefined;
    if (typeof input === "bigint") return String(input);
    if (typeof input !== "object") return "<UNSUPPORTED>";
    if (seen.has(input)) return "<CYCLE>";
    seen.add(input);
    if (input instanceof ErrorEvidence)
      return visit(preparedError(ownData(input, "error"), redactText), depth + 1);
    if (input instanceof Error) return visit(preparedError(input, redactText), depth + 1);
    if (Array.isArray(input)) {
      const length = own(input, "length");
      if (typeof length !== "number") return "<INVALID ARRAY>";
      const result: unknown[] = [];
      for (let n = 0; n < Math.min(length, 32) && remaining > 0; n++)
        result.push(visit(own(input, String(n)), depth + 1));
      return result;
    }
    let entries: Iterable<readonly [string, unknown]> = fields(input);
    if (fields === producerFields && !(input instanceof Fields)) {
      // Something carrying a message is an error, whatever its class: summarized, never
      // enumerated, so its stack, stderr or environment stay out.
      if (typeof ownData(input, "message") === "string")
        return visit(preparedError(input, redactText), depth + 1);
      try {
        if (!isPlainRecord(input)) return "<UNPREPARED OBJECT OMITTED>";
        entries = [...plainFields(input)];
      } catch {
        return "<UNPREPARED OBJECT OMITTED>";
      }
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
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
export function bounded(value: unknown, redactText: (text: string) => string): unknown {
  return normalize(value, producerFields, redactText);
}
export function boundedMetadata(value: unknown, redactText: (text: string) => string): unknown {
  return normalize(value, metadataFields, redactText);
}

/** Bounded evidence for nested external metadata; redaction precedes serialization. */
export function logMetadata(value: unknown, redact: (text: string) => string): string {
  const json = redact(JSON.stringify(boundedMetadata(value, redact)) ?? "null");
  return json.length > 2000 ? json.slice(0, 1980) + "<TRUNCATED>" : json;
}
