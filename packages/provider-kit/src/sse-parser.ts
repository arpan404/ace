import { byteLimit } from "./byte-limit.ts";
import { supervisorBackend } from "./native-switches.ts";
import { NativeSseParser } from "./native-streams.ts";

export class SseLimitError extends Error {}
export type SseLimits = { maxLineBytes?: number; maxEventBytes?: number };

export type SseEvent = { data: string; event: string; id: string };

/** Incremental UTF-8 text framing. CR, LF and split CRLF all terminate lines. */
class TypeScriptSseParser {
  lastEventId = "";
  retryMs: number | undefined;
  #line = "";
  #lineBytes = 0;
  #eventBytes = 0;
  readonly #maxLineBytes: number;
  readonly #maxEventBytes: number;
  #skipLf = false;
  #data: string[] = [];
  #event = "";
  #id: string;
  readonly #emit: (event: SseEvent) => void;
  constructor(emit: (event: SseEvent) => void, lastEventId = "", limits: SseLimits = {}) {
    this.#maxLineBytes = byteLimit(limits.maxLineBytes ?? 16 * 1024 * 1024, "maxLineBytes");
    this.#maxEventBytes = byteLimit(limits.maxEventBytes ?? 16 * 1024 * 1024, "maxEventBytes");
    this.#emit = emit;
    this.lastEventId = lastEventId;
    this.#id = lastEventId;
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
      this.#append(text.slice(start, i));
      this.#accept(this.#line);
      this.#line = "";
      this.#lineBytes = 0;
      this.#skipLf = char === "\r";
      start = i + 1;
    }
    this.#append(text.slice(start));
  }
  #append(text: string): void {
    this.#lineBytes += Buffer.byteLength(text);
    if (this.#lineBytes > this.#maxLineBytes) throw new SseLimitError("SSE line exceeded limit");
    this.#line += text;
  }
  #accept(line: string): void {
    if (line === "") {
      this.lastEventId = this.#id;
      if (this.#data.length)
        this.#emit({
          data: this.#data.join("\n"),
          event: this.#event || "message",
          id: this.lastEventId,
        });
      this.#data = [];
      this.#eventBytes = 0;
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
        this.#eventBytes += Buffer.byteLength(value) + (this.#data.length ? 1 : 0);
        if (this.#eventBytes > this.#maxEventBytes)
          throw new SseLimitError("SSE event exceeded limit");
        this.#data.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
          this.retryMs = Number(value);
        break;
    }
  }
}

/** The SSE parser `@ace/provider-kit/streams` exports; the native one is E2b's. */
export class SseParser {
  readonly #impl: {
    readonly lastEventId: string;
    readonly retryMs: number | undefined;
    feed(text: string): void;
  };
  constructor(emit: (event: SseEvent) => void, lastEventId = "", limits: SseLimits = {}) {
    this.#impl =
      supervisorBackend() === "native"
        ? new NativeSseParser(
            emit,
            lastEventId,
            byteLimit(limits.maxLineBytes ?? 16 * 1024 * 1024, "maxLineBytes"),
            byteLimit(limits.maxEventBytes ?? 16 * 1024 * 1024, "maxEventBytes"),
            (message) => new SseLimitError(message),
          )
        : new TypeScriptSseParser(emit, lastEventId, limits);
  }
  get lastEventId(): string {
    return this.#impl.lastEventId;
  }
  get retryMs(): number | undefined {
    return this.#impl.retryMs;
  }
  feed(text: string): void {
    this.#impl.feed(text);
  }
}
