// Informational synthetic workloads. Do not run under the merge-only owner policy.
import { AgentCatalog, decodeIndex, boundedBody, limits } from "../src/index.ts";
const body = Buffer.from(
  JSON.stringify({
    version: "1.0.0",
    agents: Array.from({ length: 41 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      version: "1.0.0",
      description: "Synthetic",
      license_url: "https://example.org/license",
      distribution: { future: { preserved: true } },
    })),
  }),
);
function report(name: string, operations: number, start: number) {
  const ms = performance.now() - start;
  process.stdout.write(
    `${JSON.stringify({ name, operations, opsPerSecond: (operations * 1000) / ms, microsecondsPerOp: (ms * 1000) / operations, peakRssKiB: process.resourceUsage().maxRSS, runtime: process.version })}\n`,
  );
}
const catalog = await AgentCatalog.open({
  cache: { load: async () => undefined, save: async () => {} },
  target: "linux-x86_64",
  now: () => 1,
  fetch: async () => new Response(body),
});
await catalog.refresh();
let start = performance.now();
for (let i = 0; i < 10000; i++) catalog.entry(`official:agent-${i % 41}`);
report("indexed-entry", 10000, start);
start = performance.now();
for (let i = 0; i < 1000; i++) decodeIndex(body);
report("decode-41-entries", 1000, start);
start = performance.now();
for (let i = 0; i < 100; i++)
  await boundedBody(new Response(body), limits.response, new AbortController().signal);
report("bounded-refresh-body", 100, start);
await catalog.close();
