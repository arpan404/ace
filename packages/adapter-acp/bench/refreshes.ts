// Offline benchmark; never starts a provider process. Timings are informational.
import { performance } from "node:perf_hooks";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { createAcpTranslator, createTranslatorIdentity } from "../src/index.ts";
import { SessionRouting } from "../src/session-routing.ts";
import type { Data } from "../src/data.ts";
const threadId = ThreadId.parse("benchmark");
function measureTools(count: number, updateAt: (index: number) => Data) {
  const translator = createAcpTranslator({
    threadId,
    rootKey: "root",
    identity: createTranslatorIdentity("benchmark"),
  });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90_000 } });
  let ids = 0;
  let bytes = 0;
  let rawFrames = 0;
  const ctx = { now: 0, ids: { next: () => `id-${++ids}` } };
  const start = performance.now();
  const cpuStart = process.cpuUsage();
  for (let n = 0; n < count; n++) {
    ctx.now = n;
    const update = updateAt(n);
    const facts = translator.translate(
      {
        seq: n,
        t: n,
        dir: "recv",
        channel: "stdio",
        data: { method: "session/update", params: { sessionId: "", update } },
      },
      n,
    );
    for (const fact of facts) {
      for (const event of apply(state, fact, ctx))
        bytes += Buffer.byteLength(JSON.stringify(event));
    }
    for (const item of Object.values(state.items))
      if (item.type === "tool_call") rawFrames = Math.max(rawFrames, item.call.raw.length);
  }
  const cpu = process.cpuUsage(cpuStart);
  return {
    count,
    cpuMilliseconds: Math.round((cpu.user + cpu.system) / 10) / 100,
    emittedBytes: bytes,
    maximumRawFrames: rawFrames,
    milliseconds: Math.round((performance.now() - start) * 100) / 100,
  };
}
const initialCall = {
  sessionUpdate: "tool_call",
  toolCallId: "tool",
  kind: "read",
  status: "in_progress",
  rawInput: { path: "/original", important: true },
};
function toolRefreshes(count: number) {
  return measureTools(count, (n) =>
    n === 0
      ? initialCall
      : {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool",
          title: `Refresh ${n}`,
          future: "x".repeat(512),
        },
  );
}
function partialInputs(count: number) {
  const measured = measureTools(count + 2, (n) =>
    n === 0
      ? initialCall
      : n === count + 1
        ? {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool",
            status: "completed",
          }
        : {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool",
            rawInput: { [`field${n}`]: "x".repeat(64) },
          },
  );
  return { ...measured, count };
}
function routingUpdates(history: number) {
  const routing = new SessionRouting(threadId, "root");
  for (let n = 0; n < history; n++) {
    routing.receive({
      sessionId: "root",
      update: { sessionUpdate: "subagent_spawned", subagentSessionId: `child-${n}` },
    });
    routing.receive({
      sessionId: "root",
      update: {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: `child-${n}`,
        state: "completed",
      },
    });
  }
  const start = performance.now();
  const cpuStart = process.cpuUsage();
  let live = 0;
  for (let n = 0; n < 100_000; n++) {
    routing.receive({
      sessionId: "root",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "delta" } },
    });
    live += Number(routing.hasLiveChildren);
  }
  const cpu = process.cpuUsage(cpuStart);
  return {
    historicalChildren: history,
    cpuMilliseconds: Math.round((cpu.user + cpu.system) / 10) / 100,
    notifications: 100_000,
    live,
    milliseconds: Math.round((performance.now() - start) * 100) / 100,
  };
}
// Warm parser/schema and JIT paths before reporting the same workload at increasing sizes.
toolRefreshes(250);
partialInputs(50);
routingUpdates(100);
process.stdout.write(
  `${JSON.stringify({ runtime: process.version, tools: [500, 1000, 2000].map(toolRefreshes), partialInputs: [100, 200, 400].map(partialInputs), routing: [500, 1000, 2000].map(routingUpdates) }, null, 2)}\n`,
);
