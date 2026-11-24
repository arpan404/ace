/**
 * A structured log value ace itself made (a provider kind, an ace id), never provider or person
 * text. The record keeps it as written while redaction still scrubs every other byte: only
 * `logTrusted` values are put back after `redactedLine`, so an environment value that happens to
 * spell the same word cannot blank the field.
 */
export class TrustedText {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** Marks one string as trusted structured data for `logFields` (`["provider", logTrusted(p)]`). */
export function logTrusted(text: string): TrustedText {
  return new TrustedText(text);
}

/** The key `bounded` gives a trusted value inside a record; `redactedLine` puts it back. */
export const TRUSTED_KEY = "\u0000ace.trusted\u0000";

const MAX_TRUSTED_VALUES = 32;
const MAX_DEPTH = 8;

type Path = readonly (string | number)[];

function setAtPath(root: unknown, path: Path, text: string): void {
  let node: unknown = root;
  for (let index = 0; index < path.length; index++) {
    const key = path[index];
    if (key === undefined) return;
    const last = index === path.length - 1;
    if (Array.isArray(node)) {
      if (typeof key !== "number" || key < 0 || key >= node.length) return;
      if (last) node[key] = text;
      else node = node[key];
      continue;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // A key redaction scrubbed is no longer the trusted field's; leave the record as it is.
    if (typeof key !== "string" || !Object.hasOwn(record, key)) return;
    if (last) record[key] = text;
    else node = record[key];
  }
}

/**
 * Serializes one record for a sink: redaction runs on the whole line, then each trusted value is
 * written back at the path it came from. A line redaction could not decode keeps its redacted
 * text (the trusted value is lost, never exposed).
 */
export function redactedLine(record: unknown, redact: (line: string) => string): string {
  const trusted: { path: Path; text: string }[] = [];
  const protect = (input: unknown, depth: number, path: Path): unknown => {
    if (depth > MAX_DEPTH) return input;
    if (Array.isArray(input))
      return input.map((item, index) => protect(item, depth + 1, [...path, index]));
    if (!input || typeof input !== "object") return input;
    const marker = (input as Record<string, unknown>)[TRUSTED_KEY];
    if (typeof marker === "string" && Object.keys(input).length === 1) {
      if (trusted.length >= MAX_TRUSTED_VALUES) return "<TRUSTED OMITTED>";
      trusted.push({ path, text: marker });
      return "<TRUSTED>";
    }
    if (Object.getPrototypeOf(input) !== Object.prototype) return input;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input))
      Object.defineProperty(copy, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: protect(value, depth + 1, [...path, key]),
      });
    return copy;
  };
  const line = redact(JSON.stringify(protect(record, 0, []) ?? "null"));
  if (!trusted.length) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  for (const value of trusted) setAtPath(parsed, value.path, value.text);
  return JSON.stringify(parsed);
}
