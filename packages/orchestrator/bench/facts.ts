import { performance } from "node:perf_hooks";
import { apply, create } from "../src/index.ts";
const operations = 300000;
for (const size of [1, 16, 64]) {
  let next = 0;
  const ctx = { now: 0, ids: { next: () => `id-${next++}` } };
  const { state } = create(
    {
      workspaceId: "bench",
      prompt: "Benchmark",
      baseRef: "a".repeat(40),
      targetBranch: "main",
      template: {
        kind: "fanout",
        lanes: Array.from({ length: size }, () => ({ provider: "codex", model: "bench" })),
        checks: { command: ["true"] },
        budget: {
          maxLanes: 64,
          maxDepth: 8,
          maxAttempts: 1,
          tokens: Number.MAX_SAFE_INTEGER,
          cost: Number.MAX_SAFE_INTEGER,
          durationMs: Number.MAX_SAFE_INTEGER,
        },
      },
    },
    ctx,
  );
  const lanes = Object.values(state.lanes);
  for (const type of ["usage", "thread"] as const) {
    const start = performance.now();
    for (let n = 0; n < operations; n++) {
      const lane = lanes[n % size];
      if (!lane) throw new Error("Missing benchmark lane");
      apply(
        state,
        type === "usage"
          ? { type, laneId: lane.id, attempt: 1, usage: { tokens: n, cost: 0 } }
          : {
              type,
              laneId: lane.id,
              attempt: 1,
              status:
                Math.floor(n / size) % 2
                  ? { state: "working", agents: 1 }
                  : { state: "waiting", on: "background_task" },
            },
        ctx,
      );
    }
    const elapsed = performance.now() - start;
    process.stdout.write(
      `${size} lanes ${type}: ${Math.round((operations / elapsed) * 1000)} ops/s; ${((elapsed * 1000) / operations).toFixed(2)} us/op; peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
    );
  }
}
