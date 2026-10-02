import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { OpenCodeTranslator } from "../src/index.ts";

function measure(children: number, scenario: "parts" | "backgrounds") {
  const translator = new OpenCodeTranslator({
    threadId: ThreadId.parse("thread_live_benchmark"),
    rootKey: "root",
  });
  let seq = 0;
  const event = (type: string, properties: unknown) =>
    translator.translate(
      { seq: seq++, t: 0, dir: "recv", channel: "sse", data: { payload: { type, properties } } },
      0,
    );
  event("session.created", { info: { id: "native_root" } });
  for (let i = 0; i < children; i++) {
    const id = `child_${i}`;
    event("session.created", { info: { id, parentID: "native_root" } });
    event("message.updated", { sessionID: id, info: { id: `user_${i}`, role: "user" } });
    event("session.status", { sessionID: id, status: { type: "busy" } });
    event("message.part.updated", {
      part: { id: `thought_${i}`, sessionID: id, type: "reasoning", text: "a" },
    });
    if (scenario === "backgrounds")
      event("message.part.updated", {
        part: {
          id: `spawn_${i}`,
          callID: `spawn_${i}`,
          sessionID: "native_root",
          type: "tool",
          tool: "task",
          state: { status: "completed", input: {}, metadata: { background: true, sessionId: id } },
        },
      });
  }
  const count = 1000;
  globalThis.gc?.();
  const cycleCpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    event("session.status", { sessionID: "child_0", status: { type: "busy" } });
    event("message.part.updated", {
      part: { id: "current", sessionID: "child_0", type: "reasoning", text: "a" },
    });
    event("session.status", { sessionID: "child_0", status: { type: "idle" } });
    translator.isSettled();
  }
  const cycleUs = ((performance.now() - start) * 1000) / count;
  const cycle = process.cpuUsage(cycleCpu);
  const deltaCpu = process.cpuUsage();
  const deltaStart = performance.now();
  for (let i = 0; i < 20_000; i++) {
    event("message.part.delta", {
      sessionID: "child_1",
      partID: "thought_1",
      field: "text",
      delta: "x",
    });
    translator.isSettled();
  }
  const delta = process.cpuUsage(deltaCpu);
  return {
    children,
    scenario,
    cpuCycleUs: Number(((cycle.user + cycle.system) / count).toFixed(2)),
    cpuDeltaUs: Number(((delta.user + delta.system) / 20_000).toFixed(2)),
    cycleUs: Number(cycleUs.toFixed(2)),
    deltaUs: Number((((performance.now() - deltaStart) * 1000) / 20_000).toFixed(2)),
  };
}
function median(values: number[]) {
  return values.toSorted((a, b) => a - b)[1];
}
measure(10, "parts");
const samples = ["parts", "backgrounds"].flatMap((scenario) => {
  if (scenario !== "parts" && scenario !== "backgrounds") return [];
  return [1000, 10_000].map((children) => {
    const runs = Array.from({ length: 3 }, () => measure(children, scenario));
    return {
      children,
      scenario,
      cpuCycleUs: median(runs.map((r) => r.cpuCycleUs)),
      cpuDeltaUs: median(runs.map((r) => r.cpuDeltaUs)),
      cycleUs: median(runs.map((r) => r.cycleUs)),
      deltaUs: median(runs.map((r) => r.deltaUs)),
    };
  });
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      statistic: "median of 3",
      samples,
    },
    null,
    2,
  ),
);
