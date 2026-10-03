// Synthetic frame workload; never launches an agent. Execution deferred to the merge gate.
import { redactLease } from "../src/frame-redaction.ts";
const secret = "a".repeat(64);
for (const workload of ["unchanged", "value", "key-collision"] as const) {
  const frame = {
    method: "session/update",
    params: {
      ...(workload === "key-collision"
        ? { [secret]: true, "[ace lease redacted]": "retained" }
        : {}),
      content: { text: workload === "value" ? `delta ${secret}` : "delta" },
    },
  };
  const start = performance.now();
  for (let i = 0; i < 100000; i++) redactLease(frame, [secret]);
  const ms = performance.now() - start;
  process.stdout.write(
    `${JSON.stringify({ workload, opsPerSecond: 100000000 / ms, microsecondsPerOp: ms / 100, peakRssKiB: process.resourceUsage().maxRSS, runtime: process.version })}\n`,
  );
}
