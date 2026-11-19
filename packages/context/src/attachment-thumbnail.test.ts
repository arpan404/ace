import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";
import { renderThumbnail } from "./attachment-bytes.ts";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function stored(bytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "ace-thumbnail-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "blob");
  await writeFile(path, bytes);
  return path;
}

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "teal" } });

it("a large photo's preview is a PNG at most 512 pixels a side, keeping its shape", async () => {
  const path = await stored(await photo(2000, 1000).jpeg().toBuffer());
  const preview = await sharp(await renderThumbnail(path)).metadata();
  expect(preview).toMatchObject({ format: "png", width: 512, height: 256 });
});

it("a photo taken sideways is previewed upright, from its EXIF orientation", async () => {
  // Orientation 6: the stored pixels are turned a quarter left of how the photo is seen.
  const path = await stored(
    await photo(800, 400).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
  );
  const preview = await sharp(await renderThumbnail(path)).metadata();
  expect(preview).toMatchObject({ width: 256, height: 512 });
});

for (const name of ["colours.png", "colours.jpg", "colours.webp", "colours.gif"])
  it(`a small ${name.slice("colours.".length)} is previewed at its own size, never enlarged`, async () => {
    const preview = await sharp(await renderThumbnail(fixture(name))).metadata();
    expect(preview).toMatchObject({ format: "png", width: 320, height: 240 });
  });

it("a file that is not an image gets no preview", async () => {
  const path = await stored(Buffer.from("not an image, despite its name"));
  await expect(renderThumbnail(path)).rejects.toThrow();
});

it("an image with more pixels than a preview may decode is refused", async () => {
  const path = await stored(await photo(8000, 6000).png({ compressionLevel: 9 }).toBuffer());
  await expect(renderThumbnail(path)).rejects.toThrow();
});
