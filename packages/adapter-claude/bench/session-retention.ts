// Non-gating I/O-shell bookkeeping workload. Needs run at merge.
import { SessionTasks } from "../src/session-tasks.ts";
const tasks = new SessionTasks();
const operations = 100_000;
const start = performance.now();
for (let i = 0; i < operations; i++) {
  const spawn = `tool-${i}`;
  const task_id = `task-${i}`;
  tasks.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: spawn }] } });
  tasks.observe({ type: "system", subtype: "task_started", task_id, tool_use_id: spawn });
  tasks.observe({ type: "system", subtype: "task_notification", task_id, status: "completed" });
}
const elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    tasksPerSecond: (operations / elapsed) * 1000,
    microsecondsPerTask: (elapsed * 1000) / operations,
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
);
