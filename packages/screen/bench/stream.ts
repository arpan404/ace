import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrameDecoder, FrameHub, Recording, framePacket, type Frame } from "../src/index.ts";
const mode = process.argv[2];
if (!mode) {
  for (const name of ["decode", "fanout", "recording"])
    process.stdout.write(execFileSync(process.execPath, [new URL(import.meta.url).pathname, name]));
} else {
  const payload = Buffer.alloc(128 * 1024, 1);
  const header = {
    version: 1,
    sessionId: "bench",
    sequence: 1,
    timestamp: 1000,
    width: 1920,
    height: 1080,
    codec: "jpeg",
    bytes: payload.length,
  } as const;
  const packet = framePacket(header, payload);
  const frame: Frame = { header, payload, packet };
  const start = performance.now();
  if (mode === "decode") {
    let decoded = 0;
    const decoder = new FrameDecoder(() => {
      decoded++;
    });
    for (let i = 0; i < 20_000; i++) {
      for (let offset = 0; offset < packet.length; offset += 16 * 1024)
        decoder.push(packet.subarray(offset, offset + 16 * 1024));
    }
    decoder.end();
    report("128KiB fragmented decode", decoded, start);
  } else if (mode === "fanout") {
    const hub = new FrameHub();
    for (let i = 0; i < 8; i++) hub.subscribe(async () => {});
    for (let i = 0; i < 100_000; i++) {
      hub.publish(frame);
      if (i % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    report("8-subscriber latest-frame fan-out offers", 100_000, start);
    hub.clear();
  } else if (mode === "recording") {
    const directory = await mkdtemp(join(tmpdir(), "screen-bench-"));
    try {
      const recorder = await Recording.open(directory, "bench", async () => {}, 128 * 1024 * 1024);
      const recordingStart = performance.now();
      for (let i = 0; i < 512; i++) {
        recorder.push(frame);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const artifact = await recorder.stop();
      report("bounded recording offers", 512, recordingStart);
      console.log(
        JSON.stringify({
          recordingBytes: artifact.bytes,
          persistedFrames: artifact.bytes / packet.length,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
function report(name: string, count: number, start: number) {
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      name,
      operations: count,
      opsPerSecond: Math.round((count / elapsed) * 1000),
      microsecondsPerOperation: Number(((elapsed * 1000) / count).toFixed(2)),
      peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    }),
  );
}
