import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import type { OutputFlow } from "./flow-control.ts";
import { byteLimit } from "./byte-limit.ts";
export { RpcWriter } from "./rpc-writer.ts";
/** LF only. Each chunk is scanned once; fragments are joined only at a record boundary. */
export function readJsonLines(
  input: Readable,
  maxBytes: number,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
  flow?: OutputFlow,
): () => void {
  const limit = byteLimit(maxBytes, "maxLineBytes");
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let bytes = 0;
  let failed = false;
  let detached = false;
  function fail(message: string) {
    if (failed) return;
    failed = true;
    parts = [];
    bytes = 0;
    onError(new Error(message));
  }
  function accept(text: string) {
    let start = 0;
    while (start < text.length && !failed) {
      if (detached) return;
      if (flow?.paused()) {
        input.pause();
        const pending = text.slice(start);
        void flow
          .wait()
          .then(() => {
            if (detached || failed) return;
            accept(pending);
            if (!flow.paused()) input.resume();
          })
          .catch(error);
        return;
      }
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      const part = text.slice(start, end);
      bytes += Buffer.byteLength(part);
      if (bytes > limit) {
        fail("JSONL line exceeded limit");
        return;
      }
      if (part) parts.push(part);
      if (newline < 0) return;
      let line = parts.join("");
      parts = [];
      bytes = 0;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
      start = newline + 1;
    }
  }
  const data = (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) accept(decoder.write(chunk));
    else if (typeof chunk === "string") accept(chunk);
    else fail("Invalid JSONL bytes");
  };
  const end = () => {
    accept(decoder.end());
    if (bytes) fail("Incomplete JSONL record");
  };
  const error = (cause: unknown) =>
    fail(cause instanceof Error ? cause.message : "JSONL stream failed");
  input.on("data", data);
  input.once("end", end);
  input.once("error", error);
  return () => {
    detached = true;
    input.removeListener("data", data);
    input.removeListener("end", end);
    input.removeListener("error", error);
    parts = [];
  };
}
