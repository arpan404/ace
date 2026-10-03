// Non-gating benchmark. Never contacts an installed provider CLI.
import { transitionHarness } from "../src/engine/transition-test-support.ts";
const h = transitionHarness();
try {
  const id = await h.create();
  for (let index = 0; index < 1000; index++)
    h.emit(
      id,
      {
        type: "agent.seen",
        agent: `retired-${index}`,
        parent: "root",
        origin: "provider_subagent",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: h.home,
      },
      { type: "turn.started", agent: `retired-${index}`, trigger: "spawn" },
      { type: "turn.ended", agent: `retired-${index}`, outcome: "completed" },
    );
  await h.engine.flush();
  h.held.add(id);
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "held" }],
    delivery: "queue",
  });
  await h.engine.flush();
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  const run = h.finishedRun(id);
  if (!run.nativeId) throw new Error("No stream item");
  const iterations = 10000;
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    h.emit(id, {
      type: "item.delta",
      agent: "root",
      item: run.nativeId,
      field: "text",
      append: "x",
    });
    if (index % 64 === 63) await h.engine.flush();
  }
  await h.engine.flush();
  const elapsed = performance.now() - start;
  process.stdout.write(
    JSON.stringify({
      iterations,
      opsPerSecond: (iterations / elapsed) * 1000,
      microsecondsPerOp: (elapsed * 1000) / iterations,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }) + "\n",
  );
} finally {
  await h.close();
}
