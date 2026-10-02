import { createInterface, type Interface } from "node:readline";
import { Transform, type Readable } from "node:stream";
/** Cap each unterminated line, rather than the lifetime output of a persistent process. */
export function lineReader(input: Readable, limit: number, onLimit: () => void): Interface {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid line limit");
  let bytes = 0;
  let lines: Interface | undefined;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        bytes = byte === 10 ? 0 : bytes + 1;
        if (bytes > limit) {
          callback(new Error("Process line exceeds limit"));
          return;
        }
      }
      callback(null, chunk);
    },
  });
  bounded.on("error", () => {
    input.unpipe(bounded);
    input.destroy();
    lines?.close();
    onLimit();
  });
  input.pipe(bounded);
  lines = createInterface({ input: bounded, crlfDelay: Infinity });
  lines.on("error", () => {});
  return lines;
}
