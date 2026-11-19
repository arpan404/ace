import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";
import type { ScreenStreamSettings } from "@ace/protocol";
import { SimulatorFrames } from "./simulator-frames.ts";

/** A busy screen, as hard to compress as a Simulator's: noise at JPEG quality 95. */
const busyScreen = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "grey",
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

/** Frames under `settings`, and a still taken of `bytes`. */
function frames(settings: Partial<ScreenStreamSettings>) {
  const published: { bytes: Buffer; width: number; height: number; scale: number }[] = [];
  const failures: unknown[] = [];
  const capture = new SimulatorFrames({
    fps: 30,
    now: () => 0,
    after: () => () => {},
    publish: (image, scale) => published.push({ ...image, scale }),
    failure: (error) => failures.push(error),
  });
  onTestFinished(() => capture.stop());
  capture.idle({
    codec: "jpeg",
    maxWidth: 1920,
    maxHeight: 2160,
    fps: 30,
    bitrate: 4_000_000,
    ...settings,
  });
  return {
    published,
    failures,
    async still(bytes: Buffer, width: number, height: number) {
      capture.hold(bytes, width, height);
      await capture.replay();
      return published.at(-1);
    },
  };
}

it("a frame larger than the stream's box is fitted inside it, keeping its shape", async () => {
  const source = await busyScreen(1206, 2622);
  const { still } = frames({ maxWidth: 603, maxHeight: 1400, bitrate: 50_000_000 });
  const image = await still(source, 1206, 2622);
  expect(image).toMatchObject({ width: 603, height: 1311, scale: 0.5 });
  expect(await sharp(image?.bytes).metadata()).toMatchObject({
    format: "jpeg",
    width: 603,
    height: 1311,
  });
});

it("a frame over its byte budget is re-encoded smaller, and a tighter budget makes it smaller still", async () => {
  const source = await busyScreen(600, 1300);
  // A budget of 90% of the frame encodes it at quality 77; half of it, at quality 43.
  const budget = (share: number) => Math.round(source.length * share * 8 * 30);
  const loose = await frames({ bitrate: budget(0.9) }).still(source, 600, 1300);
  const tight = await frames({ bitrate: budget(0.5) }).still(source, 600, 1300);
  // Over budget but inside the box: same size, fewer bytes.
  expect(loose).toMatchObject({ width: 600, height: 1300, scale: 1 });
  expect(loose?.bytes.length).toBeLessThan(source.length);
  expect(tight).toMatchObject({ width: 600, height: 1300 });
  expect(tight?.bytes.length).toBeLessThan(loose?.bytes.length ?? 0);
});

it("a frame inside the box and its budget is published as it came", async () => {
  const source = await busyScreen(100, 200);
  const image = await frames({ bitrate: 30_000_000 }).still(source, 100, 200);
  expect(image?.bytes.equals(source)).toBe(true);
});

it("a frame that is not a picture is reported as a failure, never published", async () => {
  const capture = frames({ maxWidth: 100, maxHeight: 100 });
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  await expect(capture.still(broken, 1206, 2622)).rejects.toThrow();
  expect(capture.published).toEqual([]);
  expect(capture.failures).toHaveLength(1);
});

/** `jpeg` cut inside its coded picture data, keeping its header (and so its dimensions). */
function cutInScan(jpeg: Buffer, keep: number) {
  let scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  scan += 2 + jpeg.readUInt16BE(scan + 2);
  return jpeg.subarray(0, scan + Math.floor((jpeg.length - scan) * keep));
}

it("a frame cut short inside its picture data is refused, though its header and size are valid", async () => {
  const whole = await busyScreen(1206, 2622);
  // Over budget and over the box (re-encoded), then small enough to pass through as it came.
  for (const settings of [{ maxWidth: 603 }, { bitrate: 1_000_000_000 }]) {
    const capture = frames(settings);
    await expect(capture.still(cutInScan(whole, 0.6), 1206, 2622)).rejects.toThrow(
      "incomplete picture",
    );
    expect(capture.published).toEqual([]);
  }
});

it("a frame cut short and followed by stray bytes or a new frame header is refused", async () => {
  const whole = await busyScreen(400, 800);
  const cut = cutInScan(whole, 0.5);
  for (const damaged of [
    Buffer.concat([cut, Buffer.from([0xff, 0xd8])]),
    Buffer.concat([cut, Buffer.from([0xff, 0xd9, 0x00, 0x00])]),
    Buffer.concat([whole.subarray(0, 40), Buffer.from([0xff, 0xd9])]),
  ]) {
    const capture = frames({ bitrate: 1_000_000_000 });
    await expect(capture.still(damaged, 400, 800)).rejects.toThrow("incomplete picture");
  }
});

it("whole baseline and progressive frames from different encoders are published", async () => {
  const pixels = sharp({
    create: {
      width: 300,
      height: 600,
      channels: 3,
      background: "grey",
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  });
  const encoded = [
    await pixels.clone().jpeg({ quality: 90 }).toBuffer(),
    await pixels.clone().jpeg({ quality: 90, progressive: true }).toBuffer(),
    await pixels.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
  ];
  for (const jpeg of encoded) {
    const image = await frames({ bitrate: 1_000_000_000 }).still(jpeg, 300, 600);
    expect(image?.bytes.equals(jpeg)).toBe(true);
    // Re-encoded by Bun's pipeline, the frame is whole too.
    const fitted = await frames({ maxWidth: 150 }).still(jpeg, 300, 600);
    expect(fitted).toMatchObject({ width: 150, height: 300 });
  }
});
