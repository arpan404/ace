import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { outputGate } from "./output-budget.ts";
import { byteLimit } from "./byte-limit.ts";
import type { OutputFlow } from "./flow-control.ts";

/** Yield one line per read. readline.pause() otherwise emits the rest of the current chunk. */
async function* framed(input: Readable, flow?: OutputFlow): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  for await (const chunk of input) {
    const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) {
        if (start < text.length) parts.push(text.slice(start));
        break;
      }
      if (flow?.paused()) await flow.wait();
      parts.push(text.slice(start, newline + 1));
      yield parts.join("");
      parts = [];
      start = newline + 1;
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
