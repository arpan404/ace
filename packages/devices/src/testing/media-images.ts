import { binaryImages, imagePixels, solidImage, testMediaBinary } from "@ace/media/testing/images";

/*
 * Pictures for device tests, made and read by a built ace-media (ADR 0201: no TypeScript image
 * codec). Tests that need them skip where `mediaBinary` is undefined.
 */

export const mediaBinary = testMediaBinary();
export const testImages = binaryImages(mediaBinary ?? "");

/** A screen painted one flat colour, as a JPEG. */
export async function flatJpeg(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  quality = 90,
): Promise<Buffer> {
  return Buffer.from(
    await solidImage(testImages, { width, height }, [...rgb, 255], { format: "jpeg", quality }),
  );
}

/** A screen of one flat colour as a PNG. */
export async function flatPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Promise<Buffer> {
  return Buffer.from(
    await solidImage(testImages, { width, height }, [...rgb, 255], { format: "png" }),
  );
}

/**
 * A busy screen, as hard to compress as a Simulator's: seeded noise drawn at half size and
 * stretched to the screen, encoded at `quality`.
 */
export async function busyJpeg(width: number, height: number, quality = 95): Promise<Buffer> {
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const noise = new Uint8Array(w * h * 4);
  let seed = 0x2545f491;
  for (let at = 0; at < noise.length; at++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[at] = at % 4 === 3 ? 255 : seed >>> 24;
  }
  const jpeg = await testImages.run({
    inputs: [{ kind: "rgba", bytes: noise, width: w, height: h }],
    op: {
      op: "compose",
      width,
      height,
      background: [128, 128, 128, 255],
      maxPixels: width * height,
      layers: [{ kind: "image", input: 0, left: 0, top: 0, width, height, fit: "fill" }],
      output: { format: "jpeg", quality },
    },
    deadlineMs: 20_000,
  });
  return Buffer.from(jpeg.bytes);
}

/** The red of an image's first pixel. */
export async function firstRed(image: Uint8Array): Promise<number> {
  return (await imagePixels(testImages, image)).data[0] ?? 0;
}

/** An image's stored format and size, from its header. */
export async function imageHeader(
  image: Uint8Array,
): Promise<{ format: string; width: number; height: number }> {
  const { source } = await testImages.run({
    inputs: [{ kind: "bytes", bytes: image }],
    op: { op: "probe", maxPixels: 50_000_000 },
    deadlineMs: 10_000,
  });
  return { format: source.format, width: source.width, height: source.height };
}
