import { z } from "zod";
import { count, decode, hashSchema, malformed } from "./decode.ts";

// cat-file --batch framing is independent of paths, attributes and diff drivers.
// Retain only a small header and a binary bit while draining arbitrarily large blobs.
export class BlobClassifier {
  readonly binary = new Set<string>();
  private readonly expected: string[];
  private index = 0;
  private header = Buffer.alloc(0);
  private remaining: number | undefined;
  private sha: string | undefined;
  private hasNul = false;
  private separator = false;
  constructor(expected: string[]) {
    this.expected = expected;
  }
  feed(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.separator) {
        if (chunk[offset++] !== 10 || !this.sha) throw malformed("blob separator");
        if (this.hasNul) this.binary.add(this.sha);
        this.index++;
        this.sha = undefined;
        this.hasNul = false;
        this.separator = false;
      } else if (this.remaining !== undefined) {
        const size = Math.min(this.remaining, chunk.length - offset);
        if (chunk.subarray(offset, offset + size).includes(0)) this.hasNul = true;
        offset += size;
        this.remaining -= size;
        if (this.remaining === 0) {
          this.remaining = undefined;
          this.separator = true;
        }
      } else {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        this.header = Buffer.concat([this.header, chunk.subarray(offset, end)]);
        if (this.header.length > 160) throw malformed("blob header size");
        offset = end;
        if (newline < 0) return;
        offset++;
        const [sha, , bytes] = decode(
          z.tuple([hashSchema, z.literal("blob"), z.string()]),
          this.header.toString("utf8").split(" "),
          "blob header",
        );
        if (sha !== this.expected[this.index]) throw malformed("blob correspondence");
        this.sha = sha;
        this.remaining = count(bytes);
        this.header = Buffer.alloc(0);
        if (this.remaining === 0) {
          this.remaining = undefined;
          this.separator = true;
        }
      }
    }
  }
  finish(): Set<string> {
    if (
      this.index !== this.expected.length ||
      this.header.length ||
      this.remaining !== undefined ||
      this.separator
    )
      throw malformed("incomplete blob stream");
    return this.binary;
  }
}
