import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { expect, test } from "vitest";
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
      expect(hash(stored)).toBe(hash(bytes));
      const decoded = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info).toMatchObject({ width: 320, height: 240 });
      expect(decoded.data).toEqual(await sharp(bytes).raw().toBuffer());
      expect((await sharp(stored).metadata()).icc).toEqual((await sharp(bytes).metadata()).icc);
    } finally {
      await f.close();
    }
  });
}
test("HEIC fails explicitly before the composer can silently send an opaque path", async () => {
  const f = await uploads();
  try {
    const bytes = Buffer.from("00000018667479706865696300000000686569636d696631", "hex");
    const id = await f.begin(bytes);
    await f.chunk(id, bytes);
    await expect(f.commit(id)).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("HEIC"),
    });
  } finally {
    await f.close();
  }
});
