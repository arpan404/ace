import { deflateSync } from "node:zlib";
import { binaryImages, imagePixels, testMediaBinary } from "@ace/media/testing/images";
import { expect, it } from "vitest";
import { modelImage, modelImageRuntime } from "./index.ts";

// The real resize (ace-media's image process, ADR 0208): a solid red PNG in, a bounded JPEG out.
const binary = testMediaBinary();
const images = binaryImages(binary ?? "");

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A PNG (ISO/IEC 15948) of one solid RGB colour. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(rgb))]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
it.skipIf(!binary)(
  "large model screenshots keep their pixels and point scale within bounded JPEG dimensions",
  async () => {
    const payload = solidPng(2000, 1000, [255, 0, 0]);
    const image = await modelImage(
      { payload, width: 2000, height: 1000, scale: 2 },
      new AbortController().signal,
      modelImageRuntime(images),
    );
    expect({ width: image.width, height: image.height, scale: image.scale }).toEqual({
      width: 1536,
      height: 768,
      scale: 1.536,
    });
    expect(image.payload.readUInt16BE(0)).toBe(0xffd8);
    expect(image.payload.length).toBeLessThanOrEqual(1024 * 1024);
    // The JPEG's SOF reports the size it was encoded at, not just the returned metadata.
    let offset = 2;
    let size: [number, number] | undefined;
    while (offset < image.payload.length && !size) {
      const marker = image.payload.readUInt16BE(offset);
      const length = image.payload.readUInt16BE(offset + 2);
      if ([0xffc0, 0xffc1, 0xffc2].includes(marker))
        size = [image.payload.readUInt16BE(offset + 7), image.payload.readUInt16BE(offset + 5)];
      offset += 2 + length;
    }
    expect(size).toEqual([1536, 768]);
    // Still red once decoded.
    const [r = 0, g = 255, b = 255] = (await imagePixels(images, image.payload)).data;
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(16);
    expect(b).toBeLessThan(16);
  },
);
