import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { createRedactor } from "@ace/redaction";

const omitted = "[Oversized output line omitted]";
/**
 * Process output as at most 200 redacted whole lines (128 KiB of JSON), oldest evicted. Line
 * framing precedes redaction, so a secret split across chunks cannot slip through, and an
 * oversized line is omitted whole.
 */
export class OutputLog {
  readonly lines: string[];
  private decoder = new StringDecoder("utf8");
  private line = "";
  private oversized = false;
  private bytes = 0;
  private redact = createRedactor({ home: homedir(), env: process.env });
  /** `lines` is filled in place, so a caller can hold the same array. */
  constructor(lines: string[] = []) {
    this.lines = lines;
  }
  write(chunk: Buffer): void {
    for (const char of this.decoder.write(chunk)) {
      if (char === "\n" || char === "\r") this.flush();
      else if (!this.oversized) {
        this.line += char;
        if (this.line.length > 4096) {
          this.line = "";
          this.oversized = true;
        }
      }
    }
  }
  flush(): void {
    if (this.line || this.oversized) {
      const clean = this.oversized ? omitted : stripVTControlCharacters(this.redact(this.line));
      const detail = clean.length > 1024 ? omitted : clean;
      this.lines.push(detail);
      // Bound bytes independently of UTF-16 length, including JSON's worst-case escaping.
      this.bytes += Buffer.byteLength(JSON.stringify(detail));
      while (this.lines.length > 200 || this.bytes > 131072) {
        const removed = this.lines.shift();
        if (removed !== undefined) this.bytes -= Buffer.byteLength(JSON.stringify(removed));
      }
    }
    this.line = "";
    this.oversized = false;
  }
}
