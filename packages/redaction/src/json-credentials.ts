import { isSecretKey } from "./secret-keys.ts";
import { accountingCounter } from "./token-counters.ts";

interface CredentialSpan {
  start: number;
  end: number;
  replacement: string;
}
const KEY_UNITS = 1024;
const whitespace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const delimiter = (char: string) => /[\s,;}\]]/.test(char);

function decodedKey(source: string): string | undefined {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function decodedEncodedKey(source: string): string | undefined {
  try {
    const value: unknown = JSON.parse('"' + source + '"');
    return typeof value === "string" ? decodedKey(value) : undefined;
  } catch {
    return undefined;
  }
}

/** Assignment markers are independent of pairing. Delimiter positions track
 * raw and JSON-escaped spellings; key reads are capped and damaged/oversized
 * keys fail closed. Cached value boundaries only scan forward, so the whole
 * scan touches each code unit O(KEY_UNITS) times, including ambiguous prose. */
export function* jsonCredentialSpans(text: string): Generator<CredentialSpan, undefined> {
  let raw = -1,
    encoded = -1,
    slashes = 0;
  let rawEnd = -1,
    encodedEnd = -1,
    scalarEnd = -1;
  function nextRawQuote(open: number): number {
    if (rawEnd > open) return rawEnd;
    let run = 0;
    for (let at = open + 1; at < text.length; at++) {
      if (text[at] === "\\") {
        run++;
        continue;
      }
      if (text[at] === '"' && run % 2 === 0) return (rawEnd = at);
      run = 0;
    }
    return (rawEnd = text.length);
  }
  function nextEncodedQuote(open: number): number {
    if (encodedEnd > open) return encodedEnd;
    let run = 0;
    for (let at = open + 1; at < text.length; at++) {
      if (text[at] === "\\") {
        run++;
        continue;
      }
      if (text[at] === '"' && run % 4 === 1) return (encodedEnd = at);
      run = 0;
    }
    return (encodedEnd = text.length);
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") {
      slashes++;
      continue;
    }
    const run = slashes;
    slashes = 0;
    if (char !== '"') continue;
    const escaped = run % 2 === 1;
    const opener = escaped ? encoded : raw;
    if (run % 2 === 0) raw = at;
    if (run % 4 === 1) encoded = at;
    let value = at + 1;
    while (whitespace(text[value])) value++;
    if (text[value] !== ":" || opener < 0) continue;
    const start = opener - (escaped ? 1 : 0);
    const key =
      at + 1 - start <= KEY_UNITS
        ? escaped
          ? decodedEncodedKey(text.slice(start, at + 1))
          : decodedKey(text.slice(start, at + 1))
        : undefined;
    if (key !== undefined && !isSecretKey(key)) continue;
    value++;
    while (whitespace(text[value])) value++;
    if (text[value] === '"') {
      const end = nextRawQuote(value);
      if (end > value + 1) yield { start: value + 1, end, replacement: "<SECRET>" };
    } else if (text[value] === "\\" && text[value + 1] === '"') {
      const end = nextEncodedQuote(value + 1);
      const contentEnd = end < text.length ? end - 1 : end;
      if (contentEnd > value + 2)
        yield { start: value + 2, end: contentEnd, replacement: "<SECRET>" };
    } else if (text[value] !== "{" && text[value] !== "[") {
      // Containers retain original key classification in the structured owner.
      if (scalarEnd < value) {
        scalarEnd = value;
        while (scalarEnd < text.length && !delimiter(text[scalarEnd] ?? "")) scalarEnd++;
      }
      if (value >= scalarEnd) continue;
      if (key !== undefined && scalarEnd - value <= KEY_UNITS) {
        try {
          const scalar: unknown = JSON.parse(text.slice(value, scalarEnd));
          if (accountingCounter(key, scalar)) continue;
        } catch {
          /* Opaque scalar diagnostics still need redaction. */
        }
      }
      yield {
        start: value,
        end: scalarEnd,
        replacement: escaped ? '\\"<SECRET>\\"' : '"<SECRET>"',
      };
    }
  }
}
