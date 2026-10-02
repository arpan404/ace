// Non-gating public-API measurements. No provider processes or prompts.
import { randomBytes } from "node:crypto";
import { ThreadId } from "@ace/protocol";
import { createCodexTranslator } from "../src/index.ts";
import type { Frame } from "@ace/engine-api";
function make() {
  const translator = createCodexTranslator({ threadId: ThreadId.parse("bench"), rootKey: "root" });
  let seq = 0;
  const feed = (dir: Frame["dir"], data: unknown) =>
    translator.translate({ seq: seq++, t: seq, dir, channel: "stdio", data }, seq);
  feed("recv", { method: "thread/started", params: { thread: { id: "native" } } });
  return { translator, feed };
}
for (const distinctIds of [false, true]) {
  const h = make();
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 10000; i++)
    h.feed("recv", {
      method: "item/agentMessage/delta",
      params: {
        threadId: distinctIds ? `unknown-${i}` : "unknown",
        itemId: "m",
        delta: randomBytes(3072).toString("base64"),
      },
    });
  h.translator.tick(1000000);
  globalThis.gc?.();
  process.stdout.write(
    JSON.stringify({
      frames: 10000,
      distinctIds,
      retainedMiB: (process.memoryUsage().heapUsed - before) / 1024 / 1024,
      translatorAlive: typeof h.translator.translate === "function",
    }) + "\n",
  );
}
for (const agents of [1000, 2000, 4000, 10000]) {
  const h = make();
  for (let i = 0; i < agents; i++)
    h.feed("note", {
      event: "thread-discovered",
      thread: { id: `child-${i}`, parentThreadId: "native" },
    });
  const iterations = 10000;
  let cpuMicros = 0,
    milliseconds = 0,
    closed = 0;
  for (let i = 0; i < iterations; i++) {
    const id = `question-${i}`;
    h.feed("recv", {
      method: "item/completed",
      params: {
        threadId: "native",
        item: {
          id,
          type: "agentMessage",
          delivery: "async",
          questions: [{ title: "Choice?", options: ["Yes", "No"] }],
        },
      },
    });
    const cpu = process.cpuUsage(),
      start = performance.now();
    const facts = h.feed("note", { event: "interaction-resolved", interaction: `async:${id}` });
    milliseconds += performance.now() - start;
    const usage = process.cpuUsage(cpu);
    cpuMicros += usage.user + usage.system;
    closed += facts.filter((f) => f.type === "interaction.closed").length;
  }
  process.stdout.write(
    JSON.stringify({
      agents,
      iterations,
      milliseconds,
      cpuMilliseconds: cpuMicros / 1000,
      closed,
    }) + "\n",
  );
}
