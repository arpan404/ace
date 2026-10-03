// Non-gating. Do not execute during authoring; the owner reserves execution for merge.
import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { OpenCodeTranslator } from "../src/index.ts";
const translator = new OpenCodeTranslator({
  threadId: ThreadId.parse("thread_bench"),
  rootKey: "root",
});
let seq = 0;
function frame(type: string, data: unknown) {
  return {
    seq: seq++,
    t: 0,
    dir: "recv" as const,
    channel: "sse",
    data: { id: `e${seq}`, type, data },
  };
}
translator.translate(
  frame("session.created", { sessionID: "root", location: { directory: "/bench" } }),
  0,
);
const count = 1000000,
  started = performance.now();
for (let n = 0; n < count; n++)
  translator.translate(
    frame("session.text.delta", {
      sessionID: "root",
      assistantMessageID: "message",
      ordinal: 0,
      delta: "text",
    }),
    0,
  );
const elapsed = performance.now() - started;
console.log(
  JSON.stringify({
    count,
    opsPerSecond: (count * 1000) / elapsed,
    microsecondsPerOp: (elapsed * 1000) / count,
    peakRss: process.resourceUsage().maxRSS,
  }),
);
