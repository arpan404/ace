import { performance } from "node:perf_hooks";
import { ServerMessage } from "@ace/protocol";
import { decodeServiceResponse } from "../src/service-requests.ts";
const reply = {
  type: "settings.result",
  requestId: "read",
  ok: true,
  entries: [{ key: "threads.autoSettleAfter", value: "1d", provenance: "defaults" }],
  diagnostics: [],
};
const query = { type: "settings.get", key: "threads.autoSettleAfter", scope: {} } as const;
const iterations = 100000;
const started = performance.now();
for (let n = 0; n < iterations; n++) decodeServiceResponse(ServerMessage, query, "read", reply);
const elapsed = performance.now() - started;
console.log(
  JSON.stringify({
    path: "service reply correlation and validation",
    opsPerSecond: iterations / (elapsed / 1000),
    microsecondsPerOp: (elapsed * 1000) / iterations,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
