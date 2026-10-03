import { performance } from "node:perf_hooks";
import { liveMetadata } from "../src/index.ts";
import { Thread, BackgroundTask, Agent } from "@ace/protocol";
const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Benchmark",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
  live: { subagentCount: 100000, backgroundTaskCount: 100000 },
});
const task = BackgroundTask.parse({
  id: "task",
  agentId: "root",
  kind: "shell",
  title: "Build",
  status: "running",
  startedAt: 0,
  stoppable: true,
  raw: [],
});
const agent = Agent.parse({
  id: "child",
  threadId: thread.id,
  parentId: "root",
  createdAt: 0,
  origin: "provider_subagent",
  native: { provider: "codex" },
  fidelity: "full",
  cwd: "/repo",
  status: { state: "idle" },
  background: false,
});
const iterations = 500000;
const started = performance.now();
for (let n = 0; n < iterations; n++) {
  liveMetadata(
    thread,
    { type: "background_task.updated", taskId: task.id, status: "completed", endedAt: 1 },
    undefined,
    task,
  );
  liveMetadata(thread, { type: "agent.created", agent }, agent);
}
const elapsed = performance.now() - started;
console.log(
  JSON.stringify({
    path: "client metadata point changes",
    opsPerSecond: (iterations * 2) / (elapsed / 1000),
    microsecondsPerOp: (elapsed * 1000) / (iterations * 2),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
