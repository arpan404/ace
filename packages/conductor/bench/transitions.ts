import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConductorStore, readyWorkstreams, reduce, selectAccount, start } from "../src/index.ts";
import type { Environment, State } from "../src/index.ts";
import { accounts, plan, spec } from "../src/test-support.ts";

let sequence = 0;
let observations = 0;
const env: Environment = {
  now: () => 100,
  id: () => `bench-${++sequence}`,
  agentId: () => `40000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
};
function build(size: number): State {
  const config = spec();
  config.constraints.maxParallel = 64;
  config.constraints.budget = 10000;
  let state = start("bench", config, env).state;
  const availability = accounts.map((a) => Object.assign({}, a, { capacity: 64, quota: 10000 }));
  state = reduce(state, { type: "accounts", accounts: availability }, env).state;
  const planner = Object.values(state.lanes)[0];
  if (!planner) throw new Error("Planner missing");
  const artifact = plan(Object.fromEntries(Array.from({ length: size }, (_, i) => [`w${i}`, []])));
  state = reduce(
    state,
    {
      type: "artifact",
      laneId: planner.id,
      generation: 0,
      artifact: { kind: "plan", plan: artifact },
    },
    env,
  ).state;
  return reduce(
    state,
    { type: "status", laneId: planner.id, generation: 0, status: "done", at: 100 },
    env,
  ).state;
}
function measure(label: string, iterations: number, operation: (i: number) => void): void {
  for (let i = 0; i < 100; i++) operation(i);
  const before = performance.now();
  for (let i = 0; i < iterations; i++) operation(i + 100);
  const ms = performance.now() - before;
  console.log(
    JSON.stringify({
      label,
      iterations,
      opsPerSecond: Math.round((iterations * 1000) / ms),
      usPerOperation: +((ms * 1000) / iterations).toFixed(2),
      peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
    }),
  );
}
for (const size of [6, 64, 256]) {
  let state = build(size);
  const lane = Object.values(state.lanes).find((l) => l.live);
  if (!lane) throw new Error("Worker missing");
  measure(`whole-thread status, ${size} workstreams`, 10000, () => {
    state = reduce(
      state,
      { type: "status", laneId: lane.id, generation: 0, status: "working", at: 100 },
      env,
    ).state;
  });
  const occupied = Object.values(state.lanes)
    .filter((l) => l.live)
    .slice(0, 32);
  measure(`account assignment, ${size} workstreams`, 10000, () => {
    observations +=
      selectAccount(state.spec, state.accounts, occupied, "reviewer", lane)?.model.quota ?? 0;
  });
  measure(`DAG readiness, ${size} workstreams`, 10000, () => {
    observations += readyWorkstreams(state).length;
  });
}
const directory = mkdtempSync(join(tmpdir(), "ace-conductor-bench-"));
const store = new ConductorStore(join(directory, "state.sqlite"));
try {
  store.create("durable", spec(), env);
  store.apply("durable", "accounts", { type: "accounts", accounts }, env);
  const planner = store.load("durable")?.planner;
  if (!planner) throw new Error("Planner missing");
  measure("SQLite snapshot + receipt, planner heartbeat", 1000, (i) => {
    store.apply(
      "durable",
      `heartbeat-${i}`,
      { type: "status", laneId: planner, generation: 0, status: "working", at: 100 },
      env,
    );
  });
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log(JSON.stringify({ observations }));
