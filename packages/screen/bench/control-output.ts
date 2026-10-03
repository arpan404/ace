import { performance } from "node:perf_hooks";
import { spawnSupervised } from "@ace/provider-kit/process";
const operations = 100_000;
const start = performance.now();
const child = spawnSupervised({
  command: process.execPath,
  args: [
    "-e",
    `const line='x'.repeat(1023)+'\\n'; let left=${operations}; function write(){while(left>0){left--;if(!process.stdout.write(line)){process.stdout.once('drain',write);return;}}}write();`,
  ],
  env: {},
  name: "screen-control-output-benchmark",
  maxLineBytes: 64 * 1024,
});
let lines = 0;
child.stdout.on("line", () => {
  lines++;
});
const exit = await child.exited;
if (exit.code !== 0 || lines !== operations) throw new Error("Incomplete output benchmark");
const elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    name: "bounded 1KiB stdout lines before readline",
    operations,
    opsPerSecond: Math.round((operations * 1000) / elapsed),
    microsecondsPerOperation: (elapsed * 1000) / operations,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
