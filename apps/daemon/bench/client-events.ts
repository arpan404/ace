// Non-gating. Do not execute before merge under the owner policy.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Thread, Run, BackgroundTask } from "@ace/protocol";
import { Store } from "../src/store.ts";
const root = await mkdtemp(join(tmpdir(), "ace-client-event-bench-"));
let sequence = 0;
const store = new Store(join(root, "events.sqlite"), console.error, {
  now: () => 0,
  nextId: () => `event-${++sequence}`,
});
try {
  const workspaceId = store.createWorkspace(root, "Benchmark");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Benchmark",
    rootAgentId: "root",
    status: { state: "new" },
    createdAt: 0,
    updatedAt: 0,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const task = BackgroundTask.parse({
    id: "shell",
    agentId: "root",
    kind: "shell",
    title: "Shell",
    status: "running",
    stoppable: true,
    startedAt: 0,
  });
  store.appendEvents(thread.id, [{ type: "background_task.started", task }]);
  const iterations = 10000,
    started = performance.now();
  for (let i = 0; i < iterations; i++)
    store.appendEvents(thread.id, [
      {
        type: "run.started",
        run: Run.parse({
          id: `turn-${i}`,
          threadId: thread.id,
          agentId: "root",
          trigger: "user",
          state: "active",
          startedAt: i,
        }),
      },
      { type: "background_task.updated", taskId: task.id, status: i % 2 ? "running" : "completed" },
    ]);
  const elapsed = performance.now() - started;
  console.log(
    JSON.stringify({
      path: "persisted root ordinals and point metadata",
      opsPerSecond: iterations / (elapsed / 1000),
      microsecondsPerBatch: (elapsed * 1000) / iterations,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
