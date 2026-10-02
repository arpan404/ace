import { Transform, type Readable } from "node:stream";
/** Count raw bytes before readline or UTF-8 decoding can accumulate a partial line. */
export function boundedLineInput(
  input: Readable,
  limit: number,
  overflow: (error: Error) => void,
): Readable {
  let bytes = 0;
  let failed = false;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (failed) {
        done();
        return;
      }
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        bytes += end - start;
        if (bytes > limit) {
          failed = true;
          overflow(new Error("Process output exceeds line limit"));
          done();
          return;
        }
        if (newline < 0) break;
        bytes = 0;
        start = newline + 1;
      }
      done(null, chunk);
    },
  });
  input.pipe(bounded);
  input.on("error", () => bounded.end());
  return bounded;
}
