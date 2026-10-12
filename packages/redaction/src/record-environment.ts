import type { EnvironmentMatcher } from "./environment.ts";

interface QuotedSpan {
  start: number;
  end: number;
  key: boolean;
}

/** Mask exact configured values in original JSON syntax. String contents and
 * keys remain original until recursive cleaning, which classifies keys first.
 * If decoding would destroy an exact match, omit its value or key's record.
 * A match crossing a string boundary omits the record rather than guessing at
 * how to repair its syntax. */
export function redactRecordEnvironment(record: string, environment?: EnvironmentMatcher): string {
  if (!environment || !environment.values.size) return record;
  const strings: QuotedSpan[] = [];
  for (let start = 0; start < record.length; start++) {
    if (record[start] !== '"') continue;
    let end = start + 1;
    for (; end < record.length; end++) {
      if (record[end] === "\\") end++;
      else if (record[end] === '"') break;
    }
    let after = end + 1;
    while (/\s/.test(record[after] ?? "") && after < record.length) after++;
    strings.push({ start, end: end + 1, key: record[after] === ":" });
    start = end;
  }
  const parts: string[] = [];
  let plain = 0;
  let quoted = 0;
  for (const { start, end } of environment.spans(record)) {
    if (start < plain) continue;
    while (strings[quoted] && (strings[quoted]?.end ?? Infinity) <= start) quoted++;
    const first = strings[quoted];
    let remainsKnown = false;
    try {
      const decoded: unknown = JSON.parse(`"${record.slice(start, end)}"`);
      remainsKnown = typeof decoded === "string" && environment.values.has(decoded);
    } catch {
      // An escape cut by the match cannot safely be repaired in place.
    }
    if (first?.key && start >= first.start && end <= first.end) {
      if (remainsKnown) continue;
      return '"<ENV>"';
    }
    if (first && start > first.start && end < first.end) {
      // Transport escapes that decode to a configured value remain exact
      // matches for recursive cleaning, including embedded JSON key checks.
      if (remainsKnown) continue;
      parts.push(record.slice(plain, first.start), '"<ENV>"');
      plain = first.end;
      continue;
    }
    if (first && start > first.start && start < first.end) return '"<ENV>"';
    let last = quoted;
    while (strings[last] && (strings[last]?.end ?? Infinity) < end) last++;
    const boundary = strings[last];
    if (boundary && end > boundary.start && end < boundary.end) return '"<ENV>"';
    parts.push(record.slice(plain, start), '"<ENV>"');
    plain = end;
  }
  parts.push(record.slice(plain));
  return parts.join("");
}
