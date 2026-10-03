import { FrameHub, framePacket } from "@ace/screen";
import { DeviceLogs } from "../src/index.ts";
import { performance } from "node:perf_hooks";
import { ScreenFrameReader } from "@ace/screen/frames-client";
import { JpegDecoder } from "../src/jpeg.ts";
const payload = Buffer.alloc(128 * 1024);
const header = {
  version: 1 as const,
  sessionId: "bench",
  sequence: 1,
  timestamp: 1,
  width: 1080,
  height: 1920,
  codec: "jpeg" as const,
  bytes: payload.length,
};
const frame = { header, payload, packet: framePacket(header, payload) };
const hub = new FrameHub();
for (let i = 0; i < 32; i++) hub.subscribe(() => new Promise<void>(() => {}));
const logs = new DeviceLogs();
logs.subscribe(() => new Promise<void>(() => {}));
const reader = new ScreenFrameReader(() => {});
// Synthetic framing payload measures accumulation and marker parsing, not JPEG encoding.
const jpegPayload = Buffer.alloc(128 * 1024);
jpegPayload.set([255, 216, 255, 192, 0, 8, 8, 7, 128, 4, 56, 1]);
jpegPayload.set([255, 217], jpegPayload.length - 2);
const jpeg = new JpegDecoder(() => {});
for (const [name, run] of [
  ["frame latest replacement, 32 viewers", () => hub.publish(frame)],
  ["bounded log replacement", () => logs.push("line")],
  [
    "128 KiB fragmented portable frame decoding",
    () => {
      reader.push(frame.packet.subarray(0, 65536));
      reader.push(frame.packet.subarray(65536));
    },
  ],
  [
    "128 KiB fragmented JPEG framing",
    () => {
      jpeg.push(jpegPayload.subarray(0, 65536));
      jpeg.push(jpegPayload.subarray(65536));
    },
  ],
] as const) {
  const count = 100000;
  const start = performance.now();
  for (let i = 0; i < count; i++) run();
  const elapsed = performance.now() - start;
  process.stdout.write(
    `${name}: ${((count / elapsed) * 1000).toFixed(0)} ops/s, ${((elapsed * 1000) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
hub.clear();
await logs.close();
