import { performance } from "node:perf_hooks";
import { FakeByteRing } from "../src/byte-ring.ts";
const ring = new FakeByteRing(262144);
const bytes = new TextEncoder().encode("snow 雪\n".repeat(128));
const iterations = 200000;
const started = performance.now();
for (let n = 0; n < iterations; n++) ring.append(bytes);
const elapsed = performance.now() - started;
console.log(
  JSON.stringify({
    path: "blocked viewer ring writes",
    opsPerSecond: iterations / (elapsed / 1000),
    microsecondsPerOp: (elapsed * 1000) / iterations,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
