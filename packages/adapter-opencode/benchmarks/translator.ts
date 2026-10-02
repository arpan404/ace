import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { OpenCodeTranslator } from "../src/index.ts";
const gc = globalThis.gc;
if (!gc) throw new Error("Run with node --expose-gc");
function translator() {
  return new OpenCodeTranslator({ threadId: ThreadId.parse("thread_benchmark"), rootKey: "root" });
}
function event(target: OpenCodeTranslator, type: string, properties: unknown) {
  return target.translate(
    { seq: 0, t: 0, dir: "recv", channel: "sse", data: { payload: { type, properties } } },
    0,
  );
}
function measure(count: number) {
  const target = translator();
  gc?.();
  const baseline = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    event(target, "message.updated", {
      sessionID: "s",
      info: { id: `m_${i}`, role: "assistant", parentID: "user" },
    });
    event(target, "message.part.updated", {
      part: {
        id: `p_${i}`,
        messageID: `m_${i}`,
        sessionID: "s",
        type: "text",
        text: `${i}:` + "x".repeat(2000),
        time: { end: 1 },
      },
    });
  }
  const ingestMs = performance.now() - start;
  gc?.();
  const retainedMiB = (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;
  event(target, "message.part.updated", {
    part: { id: "active", sessionID: "s", type: "reasoning", text: "a" },
  });
  const deltas = 50_000;
  const deltaStart = performance.now();
  for (let i = 0; i < deltas; i++) {
    event(target, "message.part.delta", {
      sessionID: "s",
      partID: "active",
      field: "text",
      delta: "x",
    });
    target.isSettled(); // Delivery shares this constant-time decision.
  }
  return {
    completedMessages: count,
    ingestMs: Number(ingestMs.toFixed(2)),
    retainedMiB: Number(retainedMiB.toFixed(2)),
    deltaUs: Number((((performance.now() - deltaStart) * 1000) / deltas).toFixed(2)),
  };
}
measure(1000); // Warm V8 before comparing different history sizes.
function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[1] ?? 0;
}
const samples = [20_000, 40_000].map((count) => {
  const runs = Array.from({ length: 3 }, () => measure(count));
  return {
    completedMessages: count,
    ingestMs: median(runs.map((r) => r.ingestMs)),
    retainedMiB: median(runs.map((r) => r.retainedMiB)),
    deltaUs: median(runs.map((r) => r.deltaUs)),
  };
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      statistic: "median of 3 after warmup",
      samples,
    },
    null,
    2,
  ),
);
