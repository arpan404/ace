import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameFanout, SessionLogs } from "../src/index.ts";
import type { BrowserFrame } from "@ace/protocol";

for (const subscribers of [1, 8, 64]) {
  const fanout = new FrameFanout();
  for (let i = 0; i < subscribers; i++) {
    const id = String(i);
    fanout.subscribe(id, {
      send: (frame) => {
        fanout.acknowledge(id, frame.sequence);
        return true;
      },
    });
  }
  const frame: BrowserFrame = {
    sequence: 0,
    timestamp: 0,
    data: "x".repeat(100_000),
    width: 1280,
    height: 720,
  };
  const iterations = 100_000;
  const start = performance.now();
  for (let i = 1; i <= iterations; i++) {
    frame.sequence = i;
    fanout.publish(frame);
  }
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      path: "frame fan-out with immediate ack",
      subscribers,
      iterations,
      opsPerSecond: Math.round((iterations / elapsed) * 1000),
      microseconds: (elapsed * 1000) / iterations,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
const dir = await mkdtemp(join(tmpdir(), "ace-browser-bench-"));
try {
  const logs = new SessionLogs(dir, 16 * 1024 * 1024);
  let accepted = 0;
  const start = performance.now();
  for (let batch = 0; batch < 100; batch++) {
    for (let i = 0; i < 100; i++)
      if (logs.append("console", { at: i, type: "log", text: "a".repeat(128) })) accepted++;
    await logs.flush();
  }
  await logs.close();
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      path: "log ingestion and disk flush",
      accepted,
      opsPerSecond: Math.round((accepted / elapsed) * 1000),
      microseconds: (elapsed * 1000) / accepted,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
