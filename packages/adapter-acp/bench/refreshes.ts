// Offline benchmark; never starts a provider process. Timings are informational.
import { performance } from "node:perf_hooks";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { createAcpTranslator, createTranslatorIdentity } from "../src/index.ts";
import { SessionRouting } from "../src/session-routing.ts";
const threadId = ThreadId.parse("benchmark");
function toolRefreshes(count: number) {
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
  for (let n = 0; n < count; n++) {
    ctx.now = n;
    const update =
      n === 0
        ? {
            sessionUpdate: "tool_call",
            toolCallId: "tool",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "/original", important: true },
          }
        : {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool",
            title: `Refresh ${n}`,
            future: "x".repeat(512),
          };
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
  return {
    count,
    emittedBytes: bytes,
    maximumRawFrames: rawFrames,
    milliseconds: Math.round((performance.now() - start) * 100) / 100,
  };
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
  let live = 0;
  for (let n = 0; n < 100_000; n++) {
    routing.receive({
      sessionId: "root",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "delta" } },
    });
    live += Number(routing.hasLiveChildren);
  }
  return {
    historicalChildren: history,
    notifications: 100_000,
    live,
    milliseconds: Math.round((performance.now() - start) * 100) / 100,
  };
}
// Warm parser/schema and JIT paths before reporting the same workload at increasing sizes.
toolRefreshes(250);
routingUpdates(100);
process.stdout.write(
  `${JSON.stringify({ runtime: process.version, tools: [500, 1000, 2000].map(toolRefreshes), routing: [500, 1000, 2000].map(routingUpdates) }, null, 2)}\n`,
);
