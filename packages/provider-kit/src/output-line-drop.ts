import { Transform } from "node:stream";

import { BoundedLineFraming, type DroppedOutputLine } from "./bounded-line-framing.ts";
export type { DroppedOutputLine } from "./bounded-line-framing.ts";
export class OutputLineDroppedError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(
      `Codex stdout reply dropped because its line exceeded the limit (at least ${bytes} bytes)`,
    );
    this.name = "OutputLineDroppedError";
    this.bytes = bytes;
  }
}

/** Keep complete lines from one input chunk together, so RPC continuations see its notifications. */
function publish(
  frames: ReturnType<BoundedLineFraming["next"]>,
  output: (bytes: Buffer) => void,
  dropped: (line: DroppedOutputLine) => void,
): void {
  let batch: Buffer[] = [];
  const flush = () => {
    if (!batch.length) return;
    output(Buffer.concat(batch));
    batch = [];
  };
  for (const frame of frames) {
    if (frame.type === "data") batch.push(frame.bytes);
    else {
      flush();
      dropped(frame.line);
    }
  }
  flush();
}

/** Hold only an admissible line; once oversized, count and skip until its delimiter. */
export function droppingOutputGate(
  limit: number,
  admit: (bytes: number) => boolean,
  fail: (error: Error) => void,
  dropped: (line: DroppedOutputLine) => void,
): Transform {
  let framing: BoundedLineFraming | undefined = new BoundedLineFraming(limit);
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!framing) return done();
      if (!admit(chunk.length)) {
        framing = undefined;
        fail(new Error("Probe output exceeded limit"));
        return done();
      }
      publish(
        framing.next(chunk),
        (bytes) => {
          this.push(bytes);
        },
        dropped,
      );
      done();
    },
    flush(done) {
      publish(
        framing?.finish() ?? [],
        (bytes) => {
          this.push(bytes);
        },
        dropped,
      );
      done();
    },
  });
}
