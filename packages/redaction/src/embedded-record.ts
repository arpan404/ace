/** End of the original enclosing token, including damaged or unclosed input.
 * Callers validate complete records before decoding; depth work stays bounded. */
export function embeddedRecordEnd(text: string, start: number): number {
  let quoted = text[start] === '"';
  let escaped = false;
  const stack: string[] = quoted ? [] : [text[start] === "{" ? "}" : "]"];
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
      if (stack.length >= 32) return text.length;
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char || !stack.length) break;
    }
  }
  return Math.min(end + 1, text.length);
}

/** Consuming a record opener must also consume the original enclosing record,
 * otherwise its now-unclassified credential value could become ordinary data. */
export function consumedRecordEnd(text: string, start: number, end: number): number {
  for (let cursor = start; cursor < end; cursor++) {
    const char = text[cursor];
    if (char === "\\") {
      cursor++;
      continue;
    }
    if (char !== "{" && char !== "[" && char !== '"') continue;
    if (char === "{") {
      let next = cursor + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next++;
      // JSON-escaped transport prose is handled after its surrounding string
      // is decoded, rather than interpreting its escaped quotes as raw keys.
      if (text[next] !== '"' && text[next] !== "}" && next < text.length) continue;
    }
    const recordEnd = embeddedRecordEnd(text, cursor);
    end = Math.max(end, recordEnd);
    cursor = recordEnd - 1;
  }
  return end;
}
