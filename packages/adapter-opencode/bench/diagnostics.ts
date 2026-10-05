import { performance } from "node:perf_hooks";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import type { Frame } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";

// Not executed: benchmarks need run at merge under the owner's execution policy.
// Run with node --expose-gc; compare this driver on 40e3b4d9 and the reviewed head.
const gc = globalThis.gc;
if (!gc) throw new Error("Run with node --expose-gc");
const threadId = ThreadId.parse("diagnostic-benchmark");

function frame(channel: string, data: unknown, index: number): Frame {
  return { channel, data, seq: index, t: index, dir: "recv" };
}

function translator() {
  const target = new OpenCodeTranslator({ threadId, rootKey: "root" });
  target.translate(
    frame(
      "snapshot.info",
      {
        root: true,
        info: { id: "native", projectID: "project", location: { directory: "/benchmark" } },
      },
      0,
    ),
    0,
  );
  target.takeDiagnostics();
  return target;
}

function unknownFrames(bytes: number): Frame[] {
  const detail = "x".repeat(bytes);
  return Array.from({ length: 512 }, (_, index) =>
    frame(
      "sse",
      {
        id: `unknown-${index}`,
        type: "future.event",
        data: { sessionID: "native", detail, api_key: "synthetic-secret" },
      },
      index + 1,
    ),
  );
}

function cumulativeSnapshots(bytes: number): Frame[] {
  return Array.from({ length: 128 }, (_, index) =>
    frame(
      "snapshot.message",
      {
        sessionID: "native",
        message: {
          id: "message",
          type: "user",
          text: "x".repeat(Math.floor((bytes * (index + 1)) / 128)),
          api_key: "synthetic-secret",
          futureMetadata: { ordinal: index },
        },
      },
      index + 1,
    ),
  );
}

function sample(frames: readonly Frame[]) {
  const target = translator();
  gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  let facts = 0;
  let diagnostics = 0;
  const started = performance.now();
  for (const input of frames) {
    facts += target.translate(input, input.t).length;
    diagnostics += target.takeDiagnostics().length;
    if (input.seq % 16 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  const milliseconds = performance.now() - started;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  gc?.();
  return {
    frames: frames.length,
    facts,
    diagnostics,
    milliseconds,
    framesPerSecond: (frames.length * 1000) / milliseconds,
    sampledPeakHeapMiB: (peak - baseline) / 1048576,
    retainedHeapMiB: (process.memoryUsage().heapUsed - baseline) / 1048576,
  };
}

function median(values: number[]) {
  const middle = values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  if (middle === undefined) throw new Error("Expected benchmark samples");
  return Number(middle.toFixed(3));
}

function measure(kind: string, bytes: number, frames: readonly Frame[]) {
  sample(frames);
  const runs = Array.from({ length: 5 }, () => sample(frames));
  return {
    kind,
    maxPayloadTextBytes: bytes,
    frames: frames.length,
    facts: median(runs.map((run) => run.facts)),
    diagnostics: median(runs.map((run) => run.diagnostics)),
    milliseconds: median(runs.map((run) => run.milliseconds)),
    framesPerSecond: median(runs.map((run) => run.framesPerSecond)),
    sampledPeakHeapMiB: median(runs.map((run) => run.sampledPeakHeapMiB)),
    retainedHeapMiB: median(runs.map((run) => run.retainedHeapMiB)),
  };
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      statistic: "median of 5 after warmup; heap sampled every 16 frames",
      samples: [4096, 65536, 262144].flatMap((bytes) => [
        measure("unknown SSE", bytes, unknownFrames(bytes)),
        measure("cumulative snapshots", bytes, cumulativeSnapshots(bytes)),
      ]),
    },
    null,
    2,
  ),
);
