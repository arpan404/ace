import type { Readable } from "node:stream";
import type { GitChildInput } from "./types.ts";

/**
 * Stream `input` into Git's stdin with backpressure, ending stdin when the input ends. Returns
 * the stop that detaches it again; after that nothing more is written.
 */
export function feedInput(input: Readable, stdin: GitChildInput): () => void {
  const resume = () => input.resume();
  const data = (chunk: Buffer | string) => {
    if (stdin.write(chunk)) return;
    input.pause();
    stdin.once("drain", resume);
  };
  const end = () => stdin.end();
  input.on("data", data);
  input.once("end", end);
  return () => {
    input.off("data", data);
    input.off("end", end);
    stdin.off("drain", resume);
  };
}
