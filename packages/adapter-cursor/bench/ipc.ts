// Non-gating; do not execute under the owner's merge-only execution policy.
import { Writable } from "node:stream";
import { boundedJson, RpcWriter } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";

const count = 100000;
const body = {
  schemaVersion: 1,
  generation: "bench",
  operationId: "operation",
  segment: 0,
  kind: "delta",
  body: { type: "text-delta", text: "delta" },
};
let start = performance.now();
let admittedBytes = 0;
for (let index = 0; index < count; index++)
  admittedBytes += new ProviderPayload(boundedJson(body)).bytes;
let elapsed = performance.now() - start;
console.log(
  JSON.stringify({
    path: "sdk-ipc-admission",
    admittedBytes,
    opsPerSecond: (count * 1000) / elapsed,
    microsPerOp: (elapsed * 1000) / count,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);

const sink = new Writable({
  write(_chunk, _encoding, callback) {
    queueMicrotask(callback);
  },
});
const writer = new RpcWriter(sink, 2_097_152);
const line = boundedJson(body) + "\n";
start = performance.now();
for (let index = 0; index < count; index++) await writer.send(line, Buffer.byteLength(line));
elapsed = performance.now() - start;
sink.end();
console.log(
  JSON.stringify({
    path: "sdk-ipc-backpressure",
    opsPerSecond: (count * 1000) / elapsed,
    microsPerOp: (elapsed * 1000) / count,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
