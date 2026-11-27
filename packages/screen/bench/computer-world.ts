/*
 * Daemon-side cost of computer-use calls: the real toolkit and client over the fake helper
 * processes of `computer/testing/world.ts`. Operates no app. Run with a phase's switch off and
 * on (ADR 0225): `bun packages/screen/bench/computer-world.ts [calls]`. Non-gating.
 */
import { performance } from "node:perf_hooks";
import { computerWorld } from "../src/computer/testing/world.ts";

const calls = Number(process.argv[2] ?? 200);
const world = await computerWorld();
const percentile = (values: number[], p: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
try {
  const cases: [string, Record<string, unknown>][] = [
    ["screen_state", { app: "Calculator" }],
    ["screen_act", { app: "Calculator", actions: [{ type: "type", text: "12*34=" }] }],
    ["screen_act", { app: "Calculator", actions: [{ type: "key", key: "Escape" }] }],
  ];
  for (const [name, args] of cases) {
    await world.call(name, args);
    const times: number[] = [];
    const cpu = process.cpuUsage();
    for (let i = 0; i < calls; i++) {
      const start = performance.now();
      await world.call(name, args);
      times.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu);
    process.stdout.write(
      `${JSON.stringify({
        name,
        args,
        calls,
        p50Ms: Number(percentile(times, 0.5).toFixed(3)),
        p95Ms: Number(percentile(times, 0.95).toFixed(3)),
        cpuUsPerCall: Math.round((used.user + used.system) / calls),
      })}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ helpersSpawned: world.children.length })}\n`);
} finally {
  await world.close();
}
