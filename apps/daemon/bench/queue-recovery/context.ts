import { performance } from "node:perf_hooks";
import { ContextSample, foldContext } from "../../src/engine/context-sample.ts";
// Non-gating pure hot path, constant-size state across a million samples and compactions.
let sample = ContextSample.parse({
  meter: { agentId: "root", epoch: 0, usedTokens: null, windowTokens: null, source: "unknown" },
  session: null,
  compaction: null,
});
const iterations = 1_000_000,
  started = performance.now();
for (let i = 0; i < iterations; i++) {
  const change =
    i % 1000 === 0
      ? { type: "compaction" as const, id: `compact-${i}` }
      : {
          type: "sample" as const,
          used: i % 100000,
          window: 128000,
          session: "native",
          model: "model",
        };
  sample = foldContext(sample, change) ?? sample;
}
const elapsed = performance.now() - started;
console.log(
  `Occupancy transitions: ${Math.round((iterations * 1000) / elapsed)} ops/s, ${((elapsed * 1000) / iterations).toFixed(3)} us/op; epoch=${sample.meter.epoch}`,
);
console.log(`Peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`);
