import { Transform } from "node:stream";
import { droppingOutputGate, type DroppedOutputLine } from "./output-line-drop.ts";
export type { DroppedOutputLine } from "./output-line-drop.ts";

export class OutputLimitError extends Error {}

/** Check raw bytes before readline or UTF-8 decoding can retain them. */
export function outputGate(
  maxLineBytes: number | undefined,
  admit: (bytes: number) => boolean,
  fail: (error: Error) => void,
  dropped?: (line: DroppedOutputLine) => void,
): Transform {
  if (dropped && maxLineBytes !== undefined)
    return droppingOutputGate(
      maxLineBytes,
      admit,
      (error) => fail(new OutputLimitError(error.message)),
      dropped,
    );
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
            fail(
              new OutputLimitError(
                `Process output line exceeded limit (line limit ${maxLineBytes} bytes)`,
              ),
            );
            done();
            return;
          }
        }
      done(null, chunk);
    },
  });
}
