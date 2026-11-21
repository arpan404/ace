import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { binaryImages, imagePixels, testMediaBinary } from "@ace/media/testing/images";
import { AttachmentBytes, previewLimit } from "./attachment-bytes.ts";
import { previewProbe, thumbnailRenderer } from "./attachment-images.ts";
import { uploads, hash, thread, attachment } from "./test-support.ts";

for (const [extension, mime] of [
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
] as const) {
  test(`${mime} survives non-base64-aligned upload chunks and a restart with exact bytes, colour and dimensions`, async () => {
    const f = await uploads();
    try {
      const bytes = await readFile(new URL(`../fixtures/colours.${extension}`, import.meta.url));
      const id = await f.begin(bytes, thread, hash(bytes), "misleading.txt");
      await f.chunk(id, bytes.subarray(0, 17));
      await f.restart();
      for (let offset = 17; offset < bytes.length; offset += 65531)
        await f.chunk(id, bytes.subarray(offset, offset + 65531), offset);
      const result = attachment(await f.commit(id));
      expect(result).toMatchObject({
        sha256: hash(bytes),
        bytes: bytes.length,
        mimeType: mime,
        width: 320,
        height: 240,
        thumbnailAvailable: true,
      });
      const stored = await readFile(
        (await f.store.attachment("device", thread, result.sha256)).path,
      );
      // Byte for byte the same file: its pixels, colour profile and size with it.
      expect(stored.equals(bytes)).toBe(true);
    } finally {
      await f.close();
    }
  });
}
/* Previews of opaque pictures come from ace-media (ADR 0208): a built binary, or none to test. */
const binary = testMediaBinary();
const images = binaryImages(binary ?? "");
/** HEIC decodes through the OS: ImageIO on macOS; Linux has no decoder ace uses. */
const heicPreviewed = process.platform === "darwin";

async function committed(f: Awaited<ReturnType<typeof uploads>>, extension: string) {
  const bytes = await readFile(new URL(`../fixtures/colours.${extension}`, import.meta.url));
  const id = await f.begin(bytes, thread, hash(bytes), `Pasted image.${extension}`);
  for (let offset = 0; offset < bytes.length; offset += 65531)
    await f.chunk(id, bytes.subarray(offset, offset + 65531), offset);
  return { bytes, file: attachment(await f.commit(id)) };
}

for (const extension of ["heic", "tiff", "bmp"] as const)
  test.skipIf(!binary || (extension === "heic" && !heicPreviewed))(
    `a ${extension} stays an opaque file the agent reads by path, with a 512-pixel preview the apps draw`,
    async () => {
      const f = await uploads({}, { previewable: previewProbe(images) });
      try {
        const { file } = await committed(f, extension);
        expect(file).toMatchObject({ kind: "binary", thumbnailAvailable: true });

        const stored = await f.store.attachment("device", thread, file.sha256);
        const previews = new AttachmentBytes(thumbnailRenderer(images));
        const parts: Buffer[] = [];
        for (let offset = 0, total = 1; offset < total; offset += 65536) {
          const window = await previews.read(stored, "thumbnail", offset, 65536);
          total = window.bytes;
          parts.push(window.data);
        }
        const preview = Buffer.concat(parts);
        expect(preview.length).toBeLessThanOrEqual(previewLimit);
        expect(preview.subarray(1, 4).toString("latin1")).toBe("PNG");
        const { width, height } = await imagePixels(images, preview);
        expect({ width, height }).toEqual({ width: 320, height: 240 });
      } finally {
        await f.close();
      }
    },
  );
test.skipIf(!binary || heicPreviewed || process.platform === "win32")(
  "a HEIC where the OS has no decoder stays an opaque file with its bytes and no preview",
  async () => {
    const f = await uploads({}, { previewable: previewProbe(images) });
    try {
      const { bytes, file } = await committed(f, "heic");
      expect(file).toMatchObject({ kind: "binary", thumbnailAvailable: false });
      const path = (await f.store.attachment("device", thread, file.sha256)).path;
      expect((await readFile(path)).equals(bytes)).toBe(true);
    } finally {
      await f.close();
    }
  },
);
test("without ace-media a TIFF stays an opaque file with no preview", async () => {
  const f = await uploads();
  try {
    const { file } = await committed(f, "tiff");
    expect(file).toMatchObject({ kind: "binary", thumbnailAvailable: false });
  } finally {
    await f.close();
  }
});
test("HEIC that doesn't decode keeps its exact bytes as an opaque file without requesting a thumbnail", async () => {
  const f = await uploads();
  try {
    const bytes = Buffer.from("00000018667479706865696300000000686569636d696631", "hex");
    const id = await f.begin(bytes);
    await f.chunk(id, bytes);
    const file = attachment(await f.commit(id));
    expect(file).toMatchObject({
      kind: "binary",
      mimeType: "image/heic",
      thumbnailAvailable: false,
    });
    expect(await readFile((await f.store.attachment("device", thread, file.sha256)).path)).toEqual(
      bytes,
    );
  } finally {
    await f.close();
  }
});
