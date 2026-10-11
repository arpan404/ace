import { sensitiveSpans } from "./literal-spans.ts";

/** One forward scan; malformed embedded records omit the remaining text. */
export function redactEmbeddedText(
  text: string,
  scrubPlain: (text: string) => string,
  scrubRecord: (record: string) => string,
  environment?: RegExp,
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
      parts.push(scrubPlain(text.slice(plain, start)), sensitive.replacement);
      start = sensitive.end - 1;
      plain = start + 1;
      continue;
    }
    const first = text[start];
    if (first !== "{" && first !== "[" && first !== '"') continue;
    parts.push(scrubPlain(text.slice(plain, start)));
    let quoted = first === '"',
      escaped = false;
    const stack: string[] = first === '"' ? [] : [first === "{" ? "}" : "]"];
    let end = start + 1;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          quoted = false;
          if (!stack.length) break;
        }
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") {
        if (stack.length >= 32) break;
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack.pop() !== char || !stack.length) break;
      }
    }
    let crossing: typeof sensitive;
    while (sensitive && sensitive.start <= end) {
      if (sensitive.end > end + 1) {
        crossing = sensitive;
        break;
      }
      sensitive = spans.next().value;
    }
    if (crossing) {
      parts.push(crossing.replacement);
      start = crossing.end - 1;
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
