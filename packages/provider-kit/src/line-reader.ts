import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { outputGate } from "./output-budget.ts";
import { byteLimit } from "./byte-limit.ts";
import type { OutputFlow } from "./flow-control.ts";
import { lineSegments } from "./line-segments.ts";

/** Yield one line per read. readline.pause() otherwise emits the rest of the current chunk. */
async function* framed(input: Readable, flow?: OutputFlow): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let skipLf = false;
  for await (const chunk of input) {
    const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    for (let segment of lineSegments(text)) {
      if (skipLf && segment.startsWith("\n")) {
        skipLf = false;
        continue;
      }
      skipLf = false;
      const ending = segment.at(-1);
      if (ending !== "\r" && ending !== "\n") {
        parts.push(segment);
        continue;
      }
      if (flow?.paused()) await flow.wait();
      skipLf = ending === "\r";
      segment = segment.slice(0, -1) + "\n";
      parts.push(segment);
      yield parts.join("");
      parts = [];
    }
  }
  parts.push(decoder.end());
  const final = parts.join("");
  if (final) {
    if (flow?.paused()) await flow.wait();
    yield final;
  }
}
export function lineReader(
  input: Readable,
  maxBytes: number,
  fail: (error: Error) => void,
  flow?: OutputFlow,
) {
  const gate = outputGate(byteLimit(maxBytes, "maxLineBytes"), () => true, fail);
  input.once("close", () => gate.end());
  gate.once("close", () => input.destroy());
  const source = Readable.from(framed(input.pipe(gate), flow), { highWaterMark: 1 });
  source.on("error", fail);
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  lines.once("close", () => source.destroy());
  return lines;
}
