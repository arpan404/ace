/** A server-sent event as Spade writes it: the `event:` name and the joined `data:` lines. */
export interface SseEvent {
  event: string;
  data: string;
}
export class SseTooLarge extends Error {
  constructor(limit: number) {
    super(`A server-sent event was larger than ${limit} characters`);
    this.name = "SseTooLarge";
  }
}

/**
 * Incremental server-sent event decoding. Text arrives in arbitrary chunks; `push` returns the
 * events completed by this chunk. Comments and `id:`/`retry:` fields are skipped, and an event
 * with no data is not dispatched, as the event-stream format says. Work is proportional to the
 * chunk, never to the stream so far.
 */
export function sseDecoder(maxEventChars: number) {
  let pending = "";
  let event = "";
  let data: string[] = [];
  let size = 0;
  const field = (line: string, out: SseEvent[]) => {
    if (line === "") {
      if (data.length) out.push({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      size = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") event = value;
    else if (name === "data") {
      size += value.length + 1;
      if (size > maxEventChars) throw new SseTooLarge(maxEventChars);
      data.push(value);
    }
  };
  return {
    push(chunk: string): SseEvent[] {
      const out: SseEvent[] = [];
      let text = pending + chunk;
      let start = 0;
      const newlines = /\r\n|\r|\n/g;
      for (let match = newlines.exec(text); match; match = newlines.exec(text)) {
        // A lone \r at the very end may be the first half of \r\n: wait for the next chunk.
        if (match[0] === "\r" && match.index + 1 === text.length) break;
        field(text.slice(start, match.index), out);
        start = match.index + match[0].length;
      }
      text = text.slice(start);
      if (text.length > maxEventChars) throw new SseTooLarge(maxEventChars);
      pending = text;
      return out;
    },
  };
}
