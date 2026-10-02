import { WorkspaceError } from "./types.ts";

type Frame = { kind: "object" | "array"; name: string; key: string; expectsKey: boolean };
/** Bounded SAX projection: discard long payload strings, emit scalars and object ends. */
export class JsonStream {
  private frames: Frame[] = [];
  private token = "";
  private string = false;
  private escaped = false;
  private collecting = false;
  private scalar = false;
  private digits = "";
  private unicode = 0;
  private surrogate = "";
  private sink: ((character: string | null) => void) | undefined;
  private readonly strings:
    | ((path: string[]) => ((character: string | null) => void) | undefined)
    | undefined;
  private stopped = false;
  private readonly value: (path: string[], value: unknown) => void;
  private readonly end: (path: string[]) => boolean;
  constructor(
    value: (path: string[], value: unknown) => void,
    end: (path: string[]) => boolean,
    strings?: (path: string[]) => ((character: string | null) => void) | undefined,
  ) {
    this.strings = strings;
    this.value = value;
    this.end = end;
  }
  private path(): string[] {
    const names = this.frames.map((frame) => frame.name).filter(Boolean);
    const last = this.frames.at(-1);
    return last?.kind === "object" ? [...names, last.key] : [...names, "[]"];
  }
  private emit(raw: string): void {
    const frame = this.frames.at(-1);
    if (frame?.kind === "object" && frame.expectsKey) {
      const key: unknown = JSON.parse(raw);
      if (typeof key !== "string") throw new Error("Invalid JSON key");
      frame.key = key;
      frame.expectsKey = false;
    } else if (this.collecting) this.value(this.path(), JSON.parse(raw));
    this.token = "";
  }
  private character(char: string): void {
    if (!this.sink) return;
    const code = char.charCodeAt(0);
    if (this.surrogate) {
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.sink(this.surrogate + char);
        this.surrogate = "";
        return;
      }
      this.sink(this.surrogate);
      this.surrogate = "";
    }
    if (code >= 0xd800 && code <= 0xdbff) this.surrogate = char;
    else this.sink(char);
  }
  push(chunk: string): boolean {
    try {
      for (let index = 0; index < chunk.length && !this.stopped; index++) {
        const char = chunk.charAt(index);
        if (this.string) {
          if (this.collecting) {
            this.token += char;
            if (this.token.length > 8192)
              throw new Error("JSON key or projected string exceeds budget");
          }
          if (this.unicode) {
            this.digits += char;
            if (--this.unicode === 0) {
              if (!/^[0-9a-fA-F]{4}$/.test(this.digits)) throw new Error("Invalid JSON escape");
              this.character(String.fromCharCode(Number.parseInt(this.digits, 16)));
            }
          } else if (this.escaped) {
            this.escaped = false;
            if (char === "u") {
              this.unicode = 4;
              this.digits = "";
            } else {
              const escapes: Record<string, string> = {
                '"': '"',
                "\\": "\\",
                "/": "/",
                b: "\b",
                f: "\f",
                n: "\n",
                r: "\r",
                t: "\t",
              };
              const decoded = escapes[char];
              if (decoded === undefined) throw new Error("Invalid JSON escape");
              this.character(decoded);
            }
          } else if (char === "\\") this.escaped = true;
          else if (char === '"') {
            this.string = false;
            if (this.surrogate) {
              this.sink?.(this.surrogate);
              this.surrogate = "";
            }
            this.sink?.(null);
            this.sink = undefined;
            if (this.collecting) this.emit(this.token);
          } else this.character(char);
          continue;
        }
        if (this.scalar) {
          if (!/[\s,}\]]/.test(char)) {
            this.token += char;
            if (this.token.length > 64) throw new Error("JSON scalar exceeds budget");
            continue;
          }
          this.scalar = false;
          this.emit(this.token);
        }
        if (char === '"') {
          const frame = this.frames.at(-1);
          const path = this.path().join("/");
          this.collecting =
            Boolean(frame?.expectsKey) || path === "type" || path === "data/path/text";
          this.token = this.collecting ? '"' : "";
          this.string = true;
          this.sink = frame?.expectsKey ? undefined : this.strings?.(this.path());
        } else if (char === "{" || char === "[") {
          const parent = this.frames.at(-1);
          this.frames.push({
            name: parent ? (parent.kind === "array" ? "[]" : parent.key) : "",
            kind: char === "{" ? "object" : "array",
            key: "",
            expectsKey: char === "{",
          });
          if (this.frames.length > 32) throw new Error("JSON nesting exceeds budget");
        } else if (char === "}" || char === "]") {
          const path = this.frames.map((frame) => frame.name).filter(Boolean);
          const frame = this.frames.pop();
          if (!frame || (char === "}") !== (frame.kind === "object"))
            throw new Error("Unbalanced JSON");
          this.stopped = !this.end(path);
        } else if (char === ",") {
          const frame = this.frames.at(-1);
          if (frame) frame.expectsKey = frame.kind === "object";
        } else if (char !== ":" && !/\s/.test(char)) {
          this.scalar = true;
          this.collecting = true;
          this.token = char;
        }
      }
      return !this.stopped;
    } catch (error) {
      throw new WorkspaceError("SEARCH_FAILED", "Malformed ripgrep JSON stream", error);
    }
  }
  finish(): void {
    if (!this.stopped && (this.string || this.scalar || this.frames.length))
      throw new WorkspaceError("SEARCH_FAILED", "Incomplete ripgrep JSON stream");
  }
}
