import { StringDecoder } from "node:string_decoder";
import { redact } from "./redact.ts";

/** Fixed byte ring. No history scans or repeated copying of accumulated logs. */
export class LogTail {
  readonly #ring: Buffer;
  readonly #decoder = new StringDecoder("utf8");
  #position = 0;
  #bytes = 0;
  #line = "";
  #lineBytes = 0;
  #discard = false;
  #truncated = false;
  constructor(cap = 16_384) {
    if (!Number.isInteger(cap) || cap < 1 || cap > 65_536) throw new RangeError("Invalid tail cap");
    this.#ring = Buffer.alloc(cap);
  }
  write(chunk: Uint8Array): void {
    this.#consume(
      this.#decoder.write(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      ),
    );
  }
  #consume(text: string): void {
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i !== text.length && text[i] !== "\n") continue;
      if (!this.#discard) {
        const part = text.slice(start, i);
        this.#lineBytes += Buffer.byteLength(part);
        this.#line += part;
        if (this.#lineBytes > 65_536) {
          this.#line = "";
          this.#lineBytes = 0;
          this.#discard = true;
          this.#truncated = true;
        }
      }
      if (i !== text.length) {
        this.#append(this.#discard ? "[oversized log line omitted]\n" : `${redact(this.#line)}\n`);
        this.#line = "";
        this.#lineBytes = 0;
        this.#discard = false;
      }
      start = i + 1;
    }
  }
  #append(text: string): void {
    const bytes = Buffer.from(text);
    this.#truncated ||= this.#bytes + bytes.length > this.#ring.length;
    const kept = bytes.subarray(Math.max(0, bytes.length - this.#ring.length));
    const first = Math.min(kept.length, this.#ring.length - this.#position);
    kept.copy(this.#ring, this.#position, 0, first);
    kept.copy(this.#ring, 0, first);
    this.#position = (this.#position + kept.length) % this.#ring.length;
    this.#bytes = Math.min(this.#ring.length, this.#bytes + kept.length);
  }
  finish(): { text: string; truncated: boolean } {
    this.#consume(this.#decoder.end());
    if (this.#line || this.#discard)
      this.#append(this.#discard ? "[oversized log line omitted]" : redact(this.#line));
    this.#line = "";
    this.#lineBytes = 0;
    this.#discard = false;
    const start = (this.#position - this.#bytes + this.#ring.length) % this.#ring.length;
    const output = Buffer.concat([
      this.#ring.subarray(start, start + this.#bytes),
      this.#ring.subarray(0, Math.max(0, start + this.#bytes - this.#ring.length)),
    ]);
    // Avoid emitting a partial UTF-8 character at the truncated start.
    let offset = 0;
    while (offset < output.length && ((output[offset] ?? 0) & 0xc0) === 0x80) offset++;
    return { text: output.subarray(offset).toString("utf8"), truncated: this.#truncated };
  }
}
