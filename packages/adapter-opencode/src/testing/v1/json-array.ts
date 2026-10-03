/** Decode a REST history array one value at a time, across arbitrary UTF-8 chunks. */
export async function* jsonArray(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let opened = false;
  let closed = false;
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let value = "";
  function* consume(text: string): Generator<unknown> {
    // Collect fragments once per value, rather than reparsing the accumulated page.
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!opened) {
        if (/\s/.test(char ?? "")) {
          start = i + 1;
          continue;
        }
        if (char !== "[") throw new Error("OpenCode history is not an array");
        opened = true;
        start = i + 1;
        continue;
      }
      if (closed) {
        if (!/\s/.test(char ?? "")) throw new Error("Trailing OpenCode history data");
        start = i + 1;
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if ((char === "," || char === "]") && depth === 0) {
        value += text.slice(start, i);
        if (value.trim()) yield JSON.parse(value);
        value = "";
        if (char === "]") closed = true;
        start = i + 1;
      } else if (char === "}" || char === "]") depth--;
      if (depth < 0) throw new Error("Invalid OpenCode history nesting");
    }
    value += text.slice(start);
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      yield* consume(decoder.decode(chunk.value, { stream: true }));
    }
    yield* consume(decoder.decode());
    if (!opened || !closed || quoted || depth !== 0) throw new Error("Truncated OpenCode history");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
