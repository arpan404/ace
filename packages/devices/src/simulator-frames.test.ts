import { readFileSync } from "node:fs";
import { expect, it, onTestFinished } from "vitest";
import type { ScreenStreamSettings } from "@ace/protocol";
import { SimulatorFrames, StillTooLarge } from "./simulator-frames.ts";
import { busyJpeg, mediaBinary } from "./testing/media-images.ts";

/* The test pictures are drawn by ace-media (ADR 0208); without a built binary these don't run. */
const drawn = it.skipIf(!mediaBinary);

/** A busy screen, as hard to compress as a Simulator's, at JPEG quality 95. */
const busyScreen = (width: number, height: number) => busyJpeg(width, height, 95);

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

drawn(
  "a frame larger than the stream's box is never re-encoded here: its still is refused as too large, and the capture goes on",
  async () => {
    const source = await busyScreen(1206, 2622);
    const capture = frames({ maxWidth: 1920, maxHeight: 2160 });
    await expect(capture.still(source, 1206, 2622)).rejects.toBeInstanceOf(StillTooLarge);
    expect(capture.published).toEqual([]);
    expect(capture.failures).toEqual([]);
    // A picture that fits, after it, is published as it came.
    const small = await busyScreen(100, 200);
    expect((await capture.still(small, 100, 200))?.bytes.equals(small)).toBe(true);
  },
);

drawn("a frame inside the box is published as it came, whatever its size in bytes", async () => {
  const source = await busyScreen(600, 1300);
  const image = await frames({ bitrate: 128_000 }).still(source, 600, 1300);
  expect(image).toMatchObject({ width: 600, height: 1300, scale: 1 });
  expect(image?.bytes.equals(source)).toBe(true);
});

drawn("a frame that is not a picture is reported as a failure, never published", async () => {
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

drawn(
  "a frame cut short inside its picture data is refused, though its header and size are valid",
  async () => {
    const whole = await busyScreen(1206, 2622);
    // Over the box, then inside it: either way the picture is checked whole first.
    for (const settings of [{ maxWidth: 603 }, { maxWidth: 1920, maxHeight: 2622 }]) {
      const capture = frames(settings);
      await expect(capture.still(cutInScan(whole, 0.6), 1206, 2622)).rejects.toThrow(
        "incomplete picture",
      );
      expect(capture.published).toEqual([]);
    }
  },
);

drawn(
  "a frame cut short and followed by stray bytes or a new frame header is refused",
  async () => {
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
  },
);

drawn("whole baseline and progressive frames from different encoders are published", async () => {
  const progressive = readFileSync(
    new URL("../../../native/media/vectors/image/inputs/progressive-40x30.jpg", import.meta.url),
  );
  for (const { jpeg, width, height } of [
    { jpeg: await busyJpeg(300, 600, 90), width: 300, height: 600 },
    { jpeg: progressive, width: 40, height: 30 },
  ]) {
    const image = await frames({ bitrate: 1_000_000_000 }).still(jpeg, width, height);
    expect(image?.bytes.equals(jpeg)).toBe(true);
  }
});
