/** Each segment has at most one CR or LF terminator. Consumers retain CRLF state. */
export function* lineSegments(text: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\r" && text[i] !== "\n") continue;
    yield text.slice(start, i + 1);
    start = i + 1;
  }
  if (start < text.length) yield text.slice(start);
}
