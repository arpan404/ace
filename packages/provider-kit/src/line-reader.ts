import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { outputGate } from "./output-budget.ts";
import { byteLimit } from "./byte-limit.ts";
import type { OutputFlow } from "./flow-control.ts";
import { lineSegments } from "./line-segments.ts";

/*
 * Node's readline also ends a line at U+2028 and U+2029, which JSON leaves unescaped inside
 * strings (KDE's Qt text and model output carry them). Lines are framed here on CR and LF
 * only, so before readline sees a line those two characters are swapped for a reversible
 * escape (U+FDD0, a noncharacter, then a digit) and restored in each emitted line.
 */
const shield = "\uFDD0";
function protect(text: string): string {
  return text.replace(/[\uFDD0\u2028\u2029]/g, (c) =>
    c === shield ? `${shield}0` : c === "\u2028" ? `${shield}1` : `${shield}2`,
  );
}
function restore(text: string): string {
  if (!text.includes(shield)) return text;
  return text.replace(/\uFDD0([012])/g, (_, digit: string) =>
    digit === "0" ? shield : digit === "1" ? "\u2028" : "\u2029",
  );
}

/** Deliver an unpaused chunk synchronously, checking intake between physical lines.
 * RPC continuations must observe every notification in their reply chunk before resuming.
 */
export function lineReader(
  input: Readable,
  maxBytes: number,
  fail: (error: Error) => void,
  flow?: OutputFlow,
) {
  const gate = outputGate(byteLimit(maxBytes, "maxLineBytes"), () => true, fail);
  const source = new PassThrough({ highWaterMark: 1 });
  const decoder = new StringDecoder("utf8");
  let segments: Iterator<string> | undefined;
  let parts: string[] = [];
  let skipLf = false;
  let ending = false;
  let blocked = false;
  let draining = false;
  const failure = (error: unknown) => {
    fail(error instanceof Error ? error : new Error(String(error)));
    source.destroy();
  };
  function drain(): void {
    if (draining || blocked || source.destroyed) return;
    draining = true;
    try {
      while (!source.isPaused()) {
        if (flow?.paused()) {
          blocked = true;
          void flow.wait().then(() => {
            blocked = false;
            drain();
          }, failure);
          return;
        }
        const next = segments?.next();
        if (!next || next.done) {
          segments = undefined;
          if (ending) {
            source.end(protect(parts.join("")));
            parts = [];
          } else gate.resume();
          return;
        }
        let segment = next.value;
        if (skipLf && segment === "\n") {
          skipLf = false;
          continue;
        }
        skipLf = false;
        const delimiter = segment.at(-1);
        if (delimiter !== "\r" && delimiter !== "\n") {
          parts.push(segment);
          continue;
        }
        skipLf = delimiter === "\r";
        segment = segment.slice(0, -1);
        parts.push(segment);
        const line = parts.join("") + "\n";
        parts = [];
        // write emits the line synchronously. A consumer pause stops the next iteration.
        source.write(protect(line));
      }
    } catch (error) {
      failure(error);
    } finally {
      draining = false;
    }
  }
  gate.on("data", (chunk: Buffer) => {
    gate.pause();
    segments = lineSegments(decoder.write(chunk));
    drain();
  });
  gate.once("end", () => {
    ending = true;
    parts.push(decoder.end());
    drain();
  });
  gate.on("error", failure);
  input.on("error", failure);
  input.once("close", () => gate.end());
  gate.once("close", () => input.destroy());
  source.on("error", failure);
  source.on("resume", drain);
  source.once("close", () => gate.destroy());
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  // Every "line" listener (and async iteration) gets the line as the process wrote it.
  const emit = lines.emit.bind(lines);
  lines.emit = (event: string | symbol, ...args: unknown[]): boolean =>
    event === "line" && typeof args[0] === "string"
      ? emit(event, restore(args[0]))
      : emit(event, ...args);
  lines.once("close", () => source.destroy());
  input.pipe(gate);
  return lines;
}
