import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { BrowserFrame } from "@ace/protocol";
import { BrowserService } from "../src/index.ts";
import { decodeStreamMessage, StreamAssembler } from "../src/stream.ts";

/*
 * Bytes on the wire and daemon CPU per browser frame, JSON (base64 in `browser.frame`) against
 * binary stream messages, for one frame fanned out to eight viewers. Part of `check:perf`: it
 * fails when binary frames stop saving about a quarter of the bytes or get slower to serialize.
 */

const viewers = 8;
const iterations = 400;
// A deterministic page-like picture: bands of text-sized detail over a gradient.
const width = 1280,
  height = 800;
const raw = Buffer.alloc(width * height * 3);
let seed = 7;
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const ink = y % 24 < 14 && seed >>> 28 > 9 ? 0 : 255;
    const offset = (y * width + x) * 3;
    raw[offset] = ink === 0 ? 20 : 240 - (y >> 3);
    raw[offset + 1] = ink === 0 ? 20 : 240 - (x >> 4);
    raw[offset + 2] = ink === 0 ? 30 : 250;
  }
const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
  .jpeg({ quality: 80 })
  .toBuffer();
const data = jpeg.toString("base64");

const home = await mkdtemp(join(tmpdir(), "ace-frame-wire-"));
const service = new BrowserService({ dataDir: home });
const frameAt = (sequence: number): BrowserFrame => ({
  sequence,
  timestamp: sequence,
  data,
  width: 1280,
  height: 800,
  tabId: "tab-1",
});
try {
  const threadId = "bench-thread";
  let jsonBytes = 0;
  let start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const frame = frameAt(i);
    for (let viewer = 0; viewer < viewers; viewer++)
      jsonBytes = Buffer.byteLength(service.serializeFrame(threadId, frame));
  }
  const jsonMicroseconds = ((performance.now() - start) * 1000) / iterations;

  let binaryBytes = 0;
  start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const frame = frameAt(i);
    for (let viewer = 0; viewer < viewers; viewer++)
      binaryBytes = service
        .streamFrame(threadId, frame)
        .reduce((total, piece) => total + piece.length, 0);
  }
  const binaryMicroseconds = ((performance.now() - start) * 1000) / iterations;

  // The receiving side: pieces back into one JPEG, no base64 anywhere.
  const assembler = new StreamAssembler();
  start = performance.now();
  for (let i = 0; i < iterations; i++)
    for (const piece of service.streamFrame(threadId, frameAt(i))) {
      const envelope = assembler.push(piece);
      if (envelope && decodeStreamMessage(envelope)?.frame.bytes.length !== jpeg.length)
        throw new Error("Frame did not round-trip");
    }
  const receiveMicroseconds = ((performance.now() - start) * 1000) / iterations;

  const ratio = binaryBytes / jsonBytes;
  const result = {
    path: `one ${Math.round(jpeg.length / 1024)} KB JPEG frame to ${viewers} viewers`,
    jpegBytes: jpeg.length,
    jsonBytesPerFrame: jsonBytes,
    binaryBytesPerFrame: binaryBytes,
    binaryToJsonRatio: Number(ratio.toFixed(3)),
    jsonSerializeMicrosecondsPerFrame: Number(jsonMicroseconds.toFixed(1)),
    binarySerializeMicrosecondsPerFrame: Number(binaryMicroseconds.toFixed(1)),
    binaryReceiveMicrosecondsPerFrame: Number(receiveMicroseconds.toFixed(1)),
  };
  console.log(JSON.stringify(result));
  const failures: string[] = [];
  // Base64 is 4/3 of the bytes; binary framing adds a few dozen bytes per 64 KiB.
  if (ratio > 0.76) failures.push(`binary frames are ${ratio.toFixed(3)} of JSON's bytes (> 0.76)`);
  // Serializing is shared across viewers either way; binary must not cost more than JSON.
  if (binaryMicroseconds > Math.max(jsonMicroseconds * 1.5, 500))
    failures.push(
      `binary serialize ${binaryMicroseconds.toFixed(1)} µs/frame vs JSON ${jsonMicroseconds.toFixed(1)} µs`,
    );
  if (failures.length) {
    console.error(`frame wire budget: ${failures.join("; ")}`);
    process.exitCode = 1;
  }
} finally {
  await service.close();
  await rm(home, { recursive: true, force: true });
}
