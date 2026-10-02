export type SseEvent = { data: string; event: string; id: string };

/** Incremental UTF-8 text framing. CR, LF and split CRLF all terminate lines. */
export class SseParser {
  lastEventId = "";
  retryMs: number | undefined;
  #line = "";
  #skipLf = false;
  #data: string[] = [];
  #event = "";
  readonly #emit: (event: SseEvent) => void;
  constructor(emit: (event: SseEvent) => void, lastEventId = "") {
    this.#emit = emit;
    this.lastEventId = lastEventId;
  }
  feed(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.#skipLf) {
        this.#skipLf = false;
        if (char === "\n") {
          start = i + 1;
          continue;
        }
      }
      if (char !== "\r" && char !== "\n") continue;
      this.#line += text.slice(start, i);
      this.#accept(this.#line);
      this.#line = "";
      this.#skipLf = char === "\r";
      start = i + 1;
    }
    this.#line += text.slice(start);
  }
  #accept(line: string): void {
    if (line === "") {
      if (this.#data.length)
        this.#emit({
          data: this.#data.join("\n"),
          event: this.#event || "message",
          id: this.lastEventId,
        });
      this.#data = [];
      this.#event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.#data.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
          this.retryMs = Number(value);
        break;
    }
  }
}
