import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService } from "../src/index.ts";
import { Recording } from "../src/recording.ts";
import type { BrowserFrame } from "@ace/protocol";

const home = await mkdtemp(join(tmpdir(), "ace-browser-pipeline-"));
const service = new BrowserService({ dataDir: home });
try {
  const raw = {
    sessionId: 1,
    data: "x".repeat(100_000),
    metadata: { deviceWidth: 1280, deviceHeight: 720 },
  };
  // Recording is what still takes the JPEG screencast (live views are video, ADR 0088).
  const recording = await Recording.start(join(home, "recording"), undefined);
  const frame: BrowserFrame = {
    sequence: 0,
    timestamp: 0,
    data: raw.data,
    width: 1280,
    height: 720,
  };
  let accepted = 0;
  const recordStart = performance.now();
  let offered = 0;
  for (let i = 0; i < 100_000 && accepted < 1000; i++) {
    offered++;
    frame.timestamp = i;
    if (recording.accept(frame)) accepted++;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await recording.stop();
  const recordElapsed = performance.now() - recordStart;
  console.log(
    JSON.stringify({
      path: "75 KB recording frames and streamed manifests to disk",
      offered,
      accepted,
      framesPerSecond: Math.round((accepted / recordElapsed) * 1000),
      microseconds: (recordElapsed * 1000) / accepted,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} finally {
  await service.close();
  await rm(home, { recursive: true, force: true });
}
