import { performance } from "node:perf_hooks";
import { ConductorStore } from "../src/index.ts";
import { environment, spec } from "../src/test-support.ts";
const store = new ConductorStore(":memory:");
store.create("run", spec(), environment());
store.release("run");
const iterations = 10000,
  started = performance.now();
for (let i = 0; i < iterations; i++) store.view("run");
const elapsed = performance.now() - started;
console.log(
  JSON.stringify({
    path: "indexed compact Deck view",
    opsPerSecond: iterations / (elapsed / 1000),
    microsecondsPerOp: (elapsed * 1000) / iterations,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
store.close();
