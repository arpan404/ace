import { performance } from "node:perf_hooks";
import { Agent, AgentId, EventId, Thread, type EventBatch } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { ThreadStore, defaultLimits } from "../src/index.ts";
const thread = Thread.parse({
  id: "parents",
  workspaceId: "workspace",
  title: "parents",
  provider: "codex",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const agent = Agent.parse({
  id: "child",
  threadId: thread.id,
  parentId: null,
  origin: "provider_subagent",
  native: { provider: "codex" },
  fidelity: "full",
  cwd: "/",
  status: { state: "working", activity: "thinking" },
  createdAt: 0,
});
const view = createThreadView(thread, 1);
view.agents[agent.id] = agent;
const store = new ThreadStore({ ...defaultLimits, entities: 1 });
store.snapshot(view);
const event = {
  seq: 2,
  id: EventId.parse("update"),
  at: 0,
  threadId: thread.id,
  payload: {
    type: "agent.updated" as const,
    agentId: agent.id,
    parentId: AgentId.parse("parent-0"),
  },
};
const batch: EventBatch = {
  type: "events",
  subscriptionId: "bench",
  afterSeq: 1,
  throughSeq: 2,
  events: [event],
};
globalThis.gc?.();
const heap = process.memoryUsage().heapUsed;
const count = 100000;
const start = performance.now();
for (let i = 0; i < count; i++) {
  event.seq = i + 2;
  event.payload.parentId = AgentId.parse(`parent-${i}`);
  batch.afterSeq = i + 1;
  batch.throughSeq = i + 2;
  store.delivery(batch);
}
const elapsed = performance.now() - start;
globalThis.gc?.();
console.log(
  JSON.stringify({
    name: "one agent reparented 100000 times with entities:1",
    opsPerSecond: Math.round((count * 1000) / elapsed),
    microsecondsPerOperation: (elapsed * 1000) / count,
    retainedHeapMiB: (process.memoryUsage().heapUsed - heap) / 1024 ** 2,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
