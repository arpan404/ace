// Non-gating. Not executed during development; measurements are deferred to merge.
import { performance } from "node:perf_hooks";
import { redactMcpCredential } from "../src/index.ts";
const connection = { url: "http://127.0.0.1:12345/mcp", bearer: "a".repeat(64) };
for (const [name, encoded] of [
  ["ordinary delta", JSON.stringify({ type: "delta", text: "text".repeat(64) })],
  [
    "echoed credential",
    JSON.stringify({ headers: { Authorization: `Bearer ${connection.bearer}` } }),
  ],
  ["large provider frame", JSON.stringify({ type: "snapshot", text: "text".repeat(65536) })],
]) {
  if (!name || !encoded) throw new Error("Missing benchmark input");
  const iterations = name === "large provider frame" ? 1000 : 100000;
  let bytes = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) bytes += redactMcpCredential(encoded, connection).length;
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      name,
      iterations,
      bytes,
      opsPerSecond: (iterations * 1000) / elapsed,
      microsecondsPerOp: (elapsed * 1000) / iterations,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
