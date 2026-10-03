// Synthetic frame workload; never launches an agent. Execution deferred to the merge gate.
import { redactLease } from "../src/frame-redaction.ts";
const secret = "a".repeat(64);
for (const echoed of [false, true]) {
  const frame = {
    method: "session/update",
    params: { content: { text: echoed ? `delta ${secret}` : "delta" } },
  };
  const start = performance.now();
  for (let i = 0; i < 100000; i++) redactLease(frame, [secret]);
  const ms = performance.now() - start;
  process.stdout.write(
    `${JSON.stringify({ echoed, opsPerSecond: 100000000 / ms, microsecondsPerOp: ms / 100, peakRssKiB: process.resourceUsage().maxRSS, runtime: process.version })}\n`,
  );
}
