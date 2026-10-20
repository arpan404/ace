/*
 * Splits the helper's stdout into reply lines without ever holding more than `maxBytes` of
 * one line. A longer line is discarded as it streams; only its first and last few kilobytes
 * are kept, to recover the request id so that request can fail at once. Pure: no I/O.
 */

export type ReplyLine =
  | { kind: "line"; text: string }
  | { kind: "oversize"; id: string | undefined };

const edgeBytes = 64 * 1024;
const idPattern = /"id"\s*:\s*"((?:[^"\\\n]|\\.){1,128})"/;

export class ReplyLines {
  private readonly maxBytes: number;
  private parts: Buffer[] = [];
  private size = 0;
  private discarding = false;
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Every line `chunk` completes, in order. */
  push(chunk: Buffer): ReplyLine[] {
    const lines: ReplyLine[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      this.take(chunk.subarray(start, newline === -1 ? chunk.length : newline));
      if (newline === -1) break;
      lines.push(this.finish());
      start = newline + 1;
    }
    return lines;
  }

  private take(piece: Buffer): void {
    if (!piece.length) return;
    if (this.discarding) {
      const joined = Buffer.concat([this.tail, piece]);
      this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - edgeBytes)));
      return;
    }
    this.parts.push(piece);
    this.size += piece.length;
    if (this.size <= this.maxBytes) return;
    const all = Buffer.concat(this.parts);
    this.head = Buffer.from(all.subarray(0, edgeBytes));
    this.tail = Buffer.from(all.subarray(Math.max(0, all.length - edgeBytes)));
    this.parts = [];
    this.size = 0;
    this.discarding = true;
  }

  private finish(): ReplyLine {
    if (this.discarding) {
      const id =
        idPattern.exec(this.head.toString("utf8"))?.[1] ??
        idPattern.exec(this.tail.toString("utf8"))?.[1];
      this.discarding = false;
      this.head = Buffer.alloc(0);
      this.tail = Buffer.alloc(0);
      return { kind: "oversize", id };
    }
    const text = Buffer.concat(this.parts).toString("utf8");
    this.parts = [];
    this.size = 0;
    return { kind: "line", text: text.endsWith("\r") ? text.slice(0, -1) : text };
  }
}
