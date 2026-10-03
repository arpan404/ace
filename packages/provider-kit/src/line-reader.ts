import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { outputGate } from "./output-budget.ts";
import { byteLimit } from "./byte-limit.ts";
export function lineReader(input: Readable, maxBytes: number, fail: (error: Error) => void) {
  const gate = outputGate(byteLimit(maxBytes, "maxLineBytes"), () => true, fail);
  input.once("close", () => gate.end());
  gate.once("close", () => input.destroy());
  return createInterface({ input: input.pipe(gate), crlfDelay: Infinity });
}
