// SPDX-License-Identifier: Apache-2.0
// Reads hyperfine's JSON and enforces ADR 0221 §5's time budgets. A benchmark tool, not a test.

import { readFileSync } from "node:fs";

/** Runs measured in-process, where §5 allows under 3 ms. */
const budgets = new Map([
  ["version", 3],
  ["help", 3],
  ["help thread", 3],
  ["completion (daemon down)", 3],
]);

let failed = false;
for (const path of process.argv.slice(2)) {
  for (const result of JSON.parse(readFileSync(path, "utf8")).results) {
    const times = result.measurements
      .map((measurement) => measurement.time_wall_clock.value * 1000)
      .toSorted((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const budget = budgets.get(result.name);
    const said = `${result.name.padEnd(26)} median ${median.toFixed(2)} ms`;
    process.stdout.write(`${said}${budget === undefined ? "" : `   budget < ${budget} ms`}\n`);
    if (budget !== undefined && !(median < budget)) {
      failed = true;
      process.stderr.write(`over budget: ${result.name} took ${median.toFixed(2)} ms\n`);
    }
  }
}
if (failed) process.exitCode = 1;
