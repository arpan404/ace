import { performance } from "node:perf_hooks";
import { agentForest, forestLayers } from "../src/agent-forest.ts";
import { wideForest } from "../src/agent-forest.fixture.ts";

/*
 * The Summary's cross-thread join (ADR 0107) at a fixed shape of four delegated threads, with only
 * the number of siblings under each main agent growing. Linear work grows with the width; the
 * quadratic join this replaced grew with its square. Run: bun run --cwd packages/ui-core bench.
 */

const threads = 4;
const widths = [250, 500, 1000, 2000, 4000];
const median = (runs: number[]) =>
  runs.toSorted((left, right) => left - right)[runs.length >> 1] ?? 0;

function measure(width: number, cached: boolean): number {
  const works = wideForest(threads, width);
  const layers = forestLayers();
  const join = () => agentForest("w0", works, undefined, cached ? layers : forestLayers());
  for (let warm = 0; warm < 5; warm++) join();
  const runs: number[] = [];
  for (let run = 0; run < 21; run++) {
    const start = performance.now();
    join();
    runs.push(performance.now() - start);
  }
  return median(runs);
}

let failed = false;
for (const cached of [false, true]) {
  const times = widths.map((width) => measure(width, cached));
  widths.forEach((width, index) =>
    process.stdout.write(
      `${cached ? "unchanged threads" : "every thread new"}: ${threads * width} agents ` +
        `${(times[index] ?? 0).toFixed(3)} ms\n`,
    ),
  );
  // Sixteen times the siblings: about 16x when linear, up to 256x when quadratic.
  const growth = (times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.01);
  process.stdout.write(`  16x the siblings took ${growth.toFixed(1)}x the time\n`);
  if (growth > 32) failed = true;
}
if (failed) {
  process.stdout.write("The join grew faster than linear in the siblings.\n");
  process.exitCode = 1;
}
