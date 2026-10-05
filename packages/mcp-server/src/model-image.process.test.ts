import { expect, it } from "vitest";
import { findExecutable } from "@ace/provider-kit/discovery";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { modelImage } from "./index.ts";

it("large model screenshots preserve pixels and point scale within bounded JPEG dimensions", async (test) => {
  const ffmpeg = await findExecutable("ffmpeg", process.env);
  if (!ffmpeg) {
    test.skip("ffmpeg unavailable; no download attempted");
    return;
  }
  // OS boundary stand-in supplies an image with known solid red pixels.
  const payload = Buffer.concat([
    Buffer.from("P6\n2000 1000\n255\n"),
    Buffer.alloc(2000 * 1000 * 3, Buffer.from([255, 0, 0])),
  ]);
  const image = await modelImage(
    { payload, width: 2000, height: 1000, scale: 2 },
    new AbortController().signal,
  );
  expect(image).toMatchObject({ width: 1536, height: 768, scale: 1.536 });
  expect(image.payload.readUInt16BE(0)).toBe(0xffd8);
  expect(image.payload.length).toBeLessThanOrEqual(1024 * 1024);
  const decoder = spawnRawSupervised({
    command: ffmpeg,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      "scale=1:1",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    env: {},
    name: "model-image-proof",
    maxOutputBytes: 8192,
  });
  const pixel: Buffer[] = [];
  decoder.stdout.on("data", (chunk: Buffer) => pixel.push(chunk));
  decoder.stderr.resume();
  decoder.stdin.end(image.payload);
  try {
    expect((await decoder.exited).code).toBe(0);
    const rgb = Buffer.concat(pixel);
    expect(rgb.length).toBe(3);
    expect(rgb[0]).toBeGreaterThan(240);
    expect(rgb[1]).toBeLessThan(10);
    expect(rgb[2]).toBeLessThan(10);
  } finally {
    await decoder.stop({ graceMs: 0 });
  }
  // The JPEG's SOF reports the actual encoded size, not just returned metadata.
  let offset = 2;
  while (offset < image.payload.length) {
    const marker = image.payload.readUInt16BE(offset);
    offset += 2;
    const length = image.payload.readUInt16BE(offset);
    if ([0xffc0, 0xffc1, 0xffc2].includes(marker)) {
      expect(image.payload.readUInt16BE(offset + 3)).toBe(768);
      expect(image.payload.readUInt16BE(offset + 5)).toBe(1536);
      return;
    }
    offset += length;
  }
  throw new Error("Missing JPEG dimensions");
});
