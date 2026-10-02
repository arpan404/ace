import { performance } from "node:perf_hooks";
import { apply, create, spawnAgent } from "../src/index.ts";
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

// Revival propagates through ancestors while unrelated starts remain pending.
for (const depth of [1, 8]) {
  let next = 0;
  const ctx = { now: 0, ids: { next: () => `revival-${next++}` } };
  const { state } = create(
    {
      workspaceId: "bench",
      prompt: "Benchmark revival",
      baseRef: "a".repeat(40),
      targetBranch: "main",
      template: {
        kind: "coordinator",
        lanes: [{ provider: "codex", model: "bench" }],
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
  const root = Object.values(state.lanes)[0];
  if (!root) throw new Error("Missing root");
  const chain = [root];
  const spawn = (parent: typeof root) => {
    const result = spawnAgent(
      state,
      { laneId: parent.id, attempt: parent.attempt },
      { requestId: `spawn-${next++}`, spec: parent.spec, prompt: "Subtask" },
      ctx,
    );
    const lane = result.laneId ? state.lanes[result.laneId] : undefined;
    if (!lane) throw new Error("Missing spawned lane");
    return lane;
  };
  for (let i = 0; i < depth; i++) chain.push(spawn(chain.at(-1) ?? root));
  while (Object.keys(state.lanes).length < 64) spawn(root);
  const settle = (lane: typeof root) => {
    const identity = { laneId: lane.id, attempt: lane.attempt };
    apply(
      state,
      {
        type: "artifact",
        ...identity,
        artifact: { checkpoint: "checkpoint", summary: "Summary", tests: { passed: 1, failed: 0 } },
      },
      ctx,
    );
    let entry = apply(state, { type: "thread", ...identity, status: { state: "done" } }, ctx)
      .intents[0];
    while (entry?.effect.type === "check") {
      entry = apply(
        state,
        {
          type: "checked",
          laneId: entry.effect.laneId,
          attempt: entry.effect.attempt,
          intentId: entry.id,
          commandPassed: true,
        },
        ctx,
      ).intents[0];
    }
  };
  for (const lane of chain.toReversed()) settle(lane);
  const leaf = chain.at(-1);
  if (!leaf) throw new Error("Missing leaf");
  const cycles = 10000;
  const start = performance.now();
  for (let n = 0; n < cycles; n++) {
    apply(
      state,
      {
        type: "thread",
        laneId: leaf.id,
        attempt: leaf.attempt,
        status: { state: "working", agents: 1 },
      },
      ctx,
    );
    settle(leaf);
  }
  const elapsed = performance.now() - start;
  process.stdout.write(
    `64 lanes depth ${depth} revival/check: ${Math.round((cycles / elapsed) * 1000)} cycles/s; ${((elapsed * 1000) / cycles).toFixed(2)} us/cycle; peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
