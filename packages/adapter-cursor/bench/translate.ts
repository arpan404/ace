// Non-gating. Do not execute under the owner's merge-only execution policy.
import { createCursorAdapter } from "../src/index.ts";
import { ThreadId } from "@ace/protocol";
const translate = createCursorAdapter().createTranslator({
  threadId: ThreadId.parse("bench"),
  rootKey: "root",
});
const frame = (seq: number, kind: string, body: unknown) => ({
  seq,
  t: seq,
  dir: "recv" as const,
  channel: "sdk",
  data: {
    schemaVersion: 1,
    generation: "bench-host",
    operationId: "bench-operation",
    segment: 0,
    kind,
    body,
  },
});
translate.translate(frame(1, "open", { cwd: "/bench" }), 1);
translate.translate(frame(2, "send", { input: [] }), 2);
const count = 100000;
const start = performance.now();
for (let i = 0; i < count; i++)
  translate.translate(frame(i + 3, "delta", { type: "text-delta", text: "delta" }), i + 3);
const elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    path: "sdk-delta-admission-translation",
    opsPerSecond: (count * 1000) / elapsed,
    microsPerOp: (elapsed * 1000) / count,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
