// Non-gating measurements; no provider processes or prompts.
import { randomBytes } from "node:crypto";
import { ThreadId } from "@ace/protocol";
import { createCodexTranslator } from "../src/index.ts";
import type { Frame } from "@ace/engine-api";
const make = () => {
  const translator = createCodexTranslator({
    threadId: ThreadId.parse("benchmark"),
    rootKey: "root",
  });
  let seq = 0;
  const recv = (method: string, params: unknown) =>
    translator.translate(
      { seq: seq++, t: seq, dir: "recv", channel: "stdio", data: { method, params } },
      seq,
    );
  recv("thread/started", { thread: { id: "native" } });
  recv("turn/started", { threadId: "native", turn: { id: "turn" } });
  return { translator, recv };
};
function measurePlan(chunks: number) {
  const h = make();
  let bytes = 0;
  let upserts = 0;
  const started = performance.now();
  const cpu = process.cpuUsage();
  const count = (facts: ReturnType<typeof h.recv>) => {
    for (const fact of facts) {
      bytes += Buffer.byteLength(JSON.stringify(fact));
      if (
        fact.type === "item.upsert" &&
        fact.draft.type === "tool_call" &&
        fact.draft.call?.kind === "plan"
      )
        upserts++;
    }
  };
  count(
    h.recv("item/started", {
      threadId: "native",
      turnId: "turn",
      item: { id: "p", type: "plan", text: "" },
    }),
  );
  for (let i = 0; i < chunks; i++)
    count(h.recv("item/plan/delta", { threadId: "native", itemId: "p", delta: "x".repeat(100) }));
  count(
    h.recv("item/completed", {
      threadId: "native",
      turnId: "turn",
      item: { id: "p", type: "plan", text: "x".repeat(chunks * 100) },
    }),
  );
  return {
    chunks,
    milliseconds: performance.now() - started,
    cpuMilliseconds: (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000,
    emittedBytes: bytes,
    planUpserts: upserts,
  };
}
for (const chunks of [1000, 2000, 4000])
  process.stdout.write(JSON.stringify(measurePlan(chunks)) + "\n");
// Keep only the translator alive. Canonical history belongs to the engine, not its replay buffer.
const h = make();
globalThis.gc?.();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 10000; i++) {
  const frame: Frame = {
    seq: i,
    t: i,
    dir: "recv",
    channel: "stdio",
    data: {
      method: "item/agentMessage/delta",
      params: { threadId: "unknown", itemId: "m", delta: randomBytes(3072).toString("base64") },
    },
  };
  h.translator.translate(frame, i);
}
h.translator.tick(1000000);
globalThis.gc?.();
process.stdout.write(
  JSON.stringify({
    unknownFrames: 10000,
    retainedMiB: (process.memoryUsage().heapUsed - before) / 1024 / 1024,
    translatorAlive: typeof h.translator.translate === "function",
  }) + "\n",
);
