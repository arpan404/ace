// Non-gating scoped snapshot folding workload. Needs run at merge.
import { applyEvent, createThreadView } from "../src/index.ts";
import { AgentId, EventId, Thread, ThreadId } from "@ace/protocol";
const at = Date.parse("2026-10-02T12:00Z");
const thread = Thread.parse({
  id: "bench",
  workspaceId: "workspace",
  provider: "claude",
  title: "bench",
  status: { state: "new" },
  createdAt: at,
  updatedAt: at,
});
const view = createThreadView(thread);
const operations = 100_000;
const start = performance.now();
for (let seq = 1; seq <= operations; seq++) {
  applyEvent(view, {
    seq,
    id: EventId.parse(String(seq)),
    at,
    threadId: ThreadId.parse("bench"),
    payload: {
      type: "usage.updated",
      agentId: AgentId.parse("root"),
      inputTokens: seq,
      outputTokens: seq,
      usageScope: "model_session",
      counterKey: "session:initial",
      model: `model-${seq % 64}`,
    },
  });
}
const elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    snapshotsPerSecond: (operations / elapsed) * 1000,
    microsecondsPerSnapshot: (elapsed * 1000) / operations,
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
);
