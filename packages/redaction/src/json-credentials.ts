import { isSecretKey } from "./secret-keys.ts";

interface CredentialSpan {
  start: number;
  end: number;
}

function quotedEnd(text: string, start: number): { end: number; closed: boolean } {
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    if (text[cursor] === "\\") cursor++;
    else if (text[cursor] === '"') return { end: cursor + 1, closed: true };
  }
  return { end: text.length, closed: false };
}

/** Quoted tokens and intervening whitespace are each scanned once. Key
 * decoding/classification is linear in that key's length, with no backtracking.
 * Value spans retain the original surrounding quotes for lexical redaction. */
export function* jsonCredentialSpans(text: string): Generator<CredentialSpan, undefined> {
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '"') {
      cursor++;
      continue;
    }
    const start = cursor;
    const key = quotedEnd(text, cursor);
    cursor = key.end;
    if (!key.closed) return;
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] !== ":") continue;
    cursor++;
    let secret = false;
    try {
      const decoded: unknown = JSON.parse(text.slice(start, key.end));
      secret = typeof decoded === "string" && isSecretKey(decoded);
    } catch {
      // Damaged keys remain fail-closed when their readable spelling is secret.
      secret = isSecretKey(text.slice(start + 1, key.end - 1));
    }
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] !== '"') continue;
    const valueStart = cursor + 1;
    const value = quotedEnd(text, cursor);
    cursor = value.end;
    const valueEnd = value.closed ? value.end - 1 : value.end;
    if (secret && valueStart < valueEnd) yield { start: valueStart, end: valueEnd };
    if (!value.closed) return;
  }
}
