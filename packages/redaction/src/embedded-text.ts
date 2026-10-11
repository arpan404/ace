import { sensitiveSpans } from "./literal-spans.ts";
import type { EnvironmentMatcher } from "./environment.ts";
import { embeddedRecordEnd, consumedRecordEnd } from "./embedded-record.ts";

/** One forward scan; malformed embedded records omit the remaining text. */
export function redactEmbeddedText(
  text: string,
  scrubPlain: (text: string) => string,
  scrubRecord: (record: string) => string,
  environment?: EnvironmentMatcher,
): string {
  const omitted = "<INVALID STRUCTURED DATA OMITTED>";
  // Match original prose before JSON serialization changes whitespace or escapes.
  // Records are still decoded from their original bytes so environment values
  // matching a key cannot hide its credential-container classification.
  const spans = sensitiveSpans(text, environment)[Symbol.iterator]();
  let sensitive = spans.next().value;
  const parts: string[] = [];
  let plain = 0;
  for (let start = 0; start < text.length; start++) {
    while (sensitive && sensitive.start < start) sensitive = spans.next().value;
    if (sensitive?.start === start) {
      let end = consumedRecordEnd(text, start, sensitive.end);
      let replacement = sensitive.replacement;
      sensitive = spans.next().value;
      while (sensitive && sensitive.start < end) {
        // Covered spans cannot change omitted syntax. Only scan a new suffix
        // when a span extends coverage; this cursor never moves backwards.
        if (sensitive.end > end) end = consumedRecordEnd(text, end, sensitive.end);
        if (sensitive.replacement === "<SECRET>") replacement = "<SECRET>";
        sensitive = spans.next().value;
      }
      parts.push(scrubPlain(text.slice(plain, start)), replacement);
      start = end - 1;
      plain = start + 1;
      continue;
    }
    const first = text[start];
    if (first !== "{" && first !== "[" && first !== '"') continue;
    parts.push(scrubPlain(text.slice(plain, start)));
    const end = embeddedRecordEnd(text, start) - 1;
    let crossing: typeof sensitive;
    while (sensitive && sensitive.start <= end) {
      if (sensitive.end > end + 1) {
        crossing = sensitive;
        break;
      }
      sensitive = spans.next().value;
    }
    if (crossing) {
      // The span begins inside this record. Resume scanning original syntax
      // after its closer, so a consumed next opener retains its enclosing end.
      let resume = consumedRecordEnd(text, end + 1, crossing.end);
      let replacement = crossing.replacement;
      sensitive = spans.next().value;
      while (sensitive && sensitive.start < resume) {
        if (sensitive.end > resume) resume = consumedRecordEnd(text, resume, sensitive.end);
        if (sensitive.replacement === "<SECRET>") replacement = "<SECRET>";
        sensitive = spans.next().value;
      }
      parts.push(replacement);
      start = resume - 1;
      plain = start + 1;
      continue;
    }
    const record = text.slice(start, end + 1);
    try {
      // Validation before redaction distinguishes damaged embedded data
      // from readable prose without guessing at the value's structure.
      JSON.parse(record);
    } catch {
      parts.push(omitted);
      return parts.join("");
    }
    parts.push(scrubRecord(record));
    start = end;
    plain = end + 1;
  }
  parts.push(scrubPlain(text.slice(plain)));
  // Reassembled quoted prose can contain a configured secret spanning scan segments.
  const result = scrubPlain(parts.join(""));
  return result.length > 262144 ? "<OVERSIZED REDACTED>" : result;
}
