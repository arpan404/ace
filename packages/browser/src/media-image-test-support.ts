import { binaryImages, imagePixels, solidImage, testMediaBinary } from "@ace/media/testing/images";

/*
 * Pixels of captures for browser tests, read by a built ace-media (ADR 0201: no TypeScript
 * image codec). A test that reads pixels without one fails, saying how to build it.
 */

export const mediaBinary = testMediaBinary();

export function testImages() {
  if (!mediaBinary)
    throw new Error(
      "This test reads pixels through ace-media: build it with `cargo build -p ace-media` in native/media.",
    );
  return binaryImages(mediaBinary);
}

/** An encoded capture's straight RGBA pixels. */
export function decodedPixels(bytes: Uint8Array) {
  return imagePixels(testImages(), bytes);
}

/** An encoded capture's width, from its header. */
export async function imageWidth(bytes: Uint8Array): Promise<number> {
  const probe = await testImages().run({
    inputs: [{ kind: "bytes", bytes }],
    op: { op: "probe", maxPixels: 50_000_000 },
    deadlineMs: 10_000,
  });
  return probe.width;
}

/** A JPEG of one colour, for tests that feed frames. */
export async function flatJpeg(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Promise<Buffer> {
  return Buffer.from(
    await solidImage(testImages(), { width, height }, [...rgb, 255], {
      format: "jpeg",
      quality: 90,
    }),
  );
}
