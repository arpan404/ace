import { performance } from "node:perf_hooks";
import { ConductorStore, progress } from "../src/index.ts";
import { fixture } from "../src/review-test-support.ts";
import { plan } from "../src/test-support.ts";

export function densePlan(size: number) {
  const project = plan(Object.fromEntries(Array.from({ length: size }, (_, i) => [`w${i}`, []])));
  for (const stream of project.workstreams)
    stream.brief.files = Array.from({ length: 128 }, (_, i) => `src/${stream.id}/file-${i}.ts`);
  return project;
}
const sizes = process.argv.includes("--baseline") ? [6, 64] : [6, 64, 256];
for (const size of sizes) {
  const context = fixture();
  try {
    const project = densePlan(size);
    await context.install(project);
    const worker = progress(context.state()).lanes[0];
    if (!worker) throw new Error("Worker missing");
    const iterations = process.argv.includes("--baseline")
      ? 1
      : process.argv.includes("--short")
        ? 50
        : 1000;
    const before = performance.now();
    for (let i = 0; i < iterations; i++)
      context.send({
        type: "status",
        laneId: worker.id,
        generation: 0,
        status: "working",
        at: context.env.now(),
      });
    const elapsed = performance.now() - before;
    const restoreStart = performance.now();
    const reopened = new ConductorStore(context.path);
    reopened.load("run");
    const restoreMs = performance.now() - restoreStart;
    reopened.close();
    console.log(
      JSON.stringify({
        label: `installed plan, ${size} workstreams × 128 paths`,
        planBytes: Buffer.byteLength(JSON.stringify(project)),
        iterations,
        opsPerSecond: Math.round((iterations * 1000) / elapsed),
        usPerOperation: +((elapsed * 1000) / iterations).toFixed(2),
        restoreMs: +restoreMs.toFixed(2),
        peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      }),
    );
  } finally {
    context.close();
  }
}
