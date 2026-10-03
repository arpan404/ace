import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConductorStore } from "../src/index.ts";
import { environment, spec } from "../src/test-support.ts";
const root = mkdtempSync(join(tmpdir(), "ace-deck-bench-"));
const path = join(root, "conductor.sqlite");
const setup = new ConductorStore(path);
setup.create("run", spec(), environment());
setup.close();
const store = new ConductorStore(path);
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

rmSync(root, { recursive: true, force: true });
