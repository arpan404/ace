import { Transform } from "node:stream";

export type DroppedOutputLine = { bytes: number; prefix: string };
export class OutputLineDroppedError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`Codex stdout reply dropped because its line exceeded the limit (${bytes} bytes)`);
    this.name = "OutputLineDroppedError";
    this.bytes = bytes;
  }
}

/** Hold only an admissible line; once oversized, count and skip until its delimiter. */
export function droppingOutputGate(
  limit: number,
  admit: (bytes: number) => boolean,
  fail: (error: Error) => void,
  dropped: (line: DroppedOutputLine) => void,
): Transform {
  let parts: Buffer[] = [];
  let bytes = 0;
  let prefix: string | undefined;
  let exceeded = false;
  const finish = () => {
    if (prefix !== undefined) dropped({ bytes, prefix });
    parts = [];
    bytes = 0;
    prefix = undefined;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (exceeded) return done();
      if (!admit(chunk.length)) {
        exceeded = true;
        parts = [];
        fail(new Error("Probe output exceeded limit"));
        return done();
      }
      let start = 0;
      for (let end = 0; end <= chunk.length; end++) {
        const delimiter = end < chunk.length && (chunk[end] === 10 || chunk[end] === 13);
        if (!delimiter && end !== chunk.length) continue;
        const size = end - start;
        bytes += size;
        if (prefix === undefined) {
          // Copy: a short tail must not retain the provider's entire input chunk.
          const remaining = Math.max(0, limit - (bytes - size));
          parts.push(Buffer.from(chunk.subarray(start, start + Math.min(size, remaining))));
          if (bytes > limit) {
            prefix = Buffer.concat(parts, Math.min(limit, 4096)).toString("utf8");
            parts = [];
          }
        }
        if (delimiter) {
          if (prefix === undefined) {
            this.push(Buffer.concat(parts));
            this.push(chunk.subarray(end, end + 1));
          }
          finish();
        }
        start = end + 1;
      }
      done();
    },
    flush(done) {
      if (!exceeded) {
        if (prefix === undefined) this.push(Buffer.concat(parts));
        finish();
      }
      done();
    },
  });
}
