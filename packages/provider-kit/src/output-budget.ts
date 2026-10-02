import { Transform } from "node:stream";

export class OutputLimitError extends Error {}

export function byteLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid ${name}`);
  return value;
}

/** Check raw bytes before readline or UTF-8 decoding can retain them. */
export function outputGate(
  maxLineBytes: number | undefined,
  admit: (bytes: number) => boolean,
  fail: (error: Error) => void,
): Transform {
  let lineBytes = 0;
  let exceeded = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (exceeded) {
        done();
        return;
      }
      if (!admit(chunk.length)) {
        exceeded = true;
        fail(new OutputLimitError("Probe output exceeded limit"));
        done();
        return;
      }
      if (maxLineBytes !== undefined)
        for (const byte of chunk) {
          if (byte === 10 || byte === 13) lineBytes = 0;
          else if (++lineBytes > maxLineBytes) {
            exceeded = true;
            fail(new OutputLimitError("Process output line exceeded limit"));
            done();
            return;
          }
        }
      done(null, chunk);
    },
  });
}
