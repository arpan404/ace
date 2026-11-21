import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryImages, imagePixels, solidImage, testMediaBinary } from "@ace/media/testing/images";
import { describe, expect, it, onTestFinished } from "vitest";
import { ContextError } from "./errors.ts";
import { thumbnailRenderer } from "./attachment-images.ts";

/* Previews come from ace-media (ADR 0201); without a built binary there is nothing to test. */
const binary = testMediaBinary();
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const vector = (name: string) =>
  fileURLToPath(new URL(`../../../native/media/vectors/image/inputs/${name}`, import.meta.url));

async function stored(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "ace-thumbnail-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "blob");
  await writeFile(path, bytes);
  return path;
}

describe.skipIf(!binary)("attachment previews", () => {
  const images = binaryImages(binary ?? "");
  const render = thumbnailRenderer(images);
  const size = async (png: Buffer) => {
    const { width, height } = await imagePixels(images, png);
    return { png: png.subarray(1, 4).toString("latin1"), width, height };
  };

  it("a large photo's preview is a PNG at most 512 pixels a side, keeping its shape", async () => {
    const photo = await solidImage(images, { width: 2000, height: 1000 }, [0, 128, 128, 255], {
      format: "jpeg",
      quality: 85,
    });
    expect(await size(await render(await stored(photo)))).toEqual({
      png: "PNG",
      width: 512,
      height: 256,
    });
  });

  it("a photo taken sideways is previewed upright, from its EXIF orientation", async () => {
    // Orientation 6, stored 30 × 20: seen as 20 × 30.
    expect(await size(await render(vector("exif-6.jpg")))).toEqual({
      png: "PNG",
      width: 20,
      height: 30,
    });
  });

  for (const name of ["colours.png", "colours.jpg", "colours.webp", "colours.gif"])
    it(`a small ${name.slice("colours.".length)} is previewed at its own size, never enlarged`, async () => {
      expect(await size(await render(fixture(name)))).toEqual({
        png: "PNG",
        width: 320,
        height: 240,
      });
    });

  it("a file that is not an image gets no preview, and says so", async () => {
    const error = await render(await stored(Buffer.from("not an image, despite its name"))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ContextError);
    expect(error instanceof ContextError && error.code).toBe("unsupported");
  });

  it("an image with more pixels than a preview may decode is refused before it is decoded", async () => {
    // A real PNG whose header says 8000 × 6000: refused on the header alone.
    const png = Buffer.from(await readFile(vector("palette-8x8.png")));
    png.writeUInt32BE(8000, 16);
    png.writeUInt32BE(6000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    const error = await render(await stored(png)).catch((e: unknown) => e);
    expect(error instanceof ContextError && [error.code, error.message]).toEqual([
      "unsupported",
      expect.stringContaining("8000 × 6000"),
    ]);
  });
});

/** CRC-32 (ISO 3309), as a PNG chunk carries it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
