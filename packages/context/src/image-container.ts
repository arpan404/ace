import { open, type FileHandle } from "node:fs/promises";
import { requireContext } from "./errors.ts";

/** Metadata-only container walk. Never inflates pixels; caps block count to bound adversarial work. */
class Reader {
  private file: FileHandle;
  private bytes: number;
  private reads = 0;
  constructor(file: FileHandle, bytes: number) {
    this.file = file;
    this.bytes = bytes;
  }
  async at(offset: number, size: number): Promise<Buffer> {
    requireContext(
      ++this.reads <= 4096 && offset >= 0 && offset + size <= this.bytes,
      "invalid_image",
      "Image container exceeds validation bounds",
    );
    const buffer = Buffer.alloc(size);
    const result = await this.file.read(buffer, 0, size, offset);
    requireContext(result.bytesRead === size, "invalid_image", "Incomplete image container");
    return buffer;
  }
}
function crc(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
async function png(reader: Reader, bytes: number): Promise<void> {
  const ihdr = await reader.at(12, 21);
  const depth = ihdr[12],
    color = ihdr[13];
  requireContext(
    crc(ihdr.subarray(0, 17)) === ihdr.readUInt32BE(17),
    "invalid_image",
    "Invalid PNG header checksum",
  );
  const depths =
    color === 0
      ? [1, 2, 4, 8, 16]
      : color === 3
        ? [1, 2, 4, 8]
        : color === 2 || color === 4 || color === 6
          ? [8, 16]
          : [];
  requireContext(
    depth !== undefined && depths.includes(depth),
    "invalid_image",
    "Invalid PNG color depth",
  );
  let position = 33,
    data = false,
    palette = false;
  while (position < bytes) {
    const header = await reader.at(position, 8);
    const length = header.readUInt32BE(0),
      type = header.subarray(4).toString("ascii");
    requireContext(
      position + length + 12 <= bytes && type !== "acTL" && type !== "IHDR",
      "invalid_image",
      "Invalid or animated PNG container",
    );
    if (type === "PLTE") {
      requireContext(
        length > 0 && length <= 768 && length % 3 === 0 && !data,
        "invalid_image",
        "Invalid PNG palette",
      );
      palette = true;
    }
    if (type === "IDAT") {
      requireContext(color !== 3 || palette, "invalid_image", "Indexed PNG requires a palette");
      data = true;
    }
    if (type === "IEND") {
      requireContext(
        data && length === 0 && position + 12 === bytes,
        "invalid_image",
        "Invalid PNG end block",
      );
      return;
    }
    position += length + 12;
  }
  requireContext(false, "invalid_image", "PNG has no end block");
}
async function gif(reader: Reader, bytes: number): Promise<void> {
  const header = await reader.at(0, 13);
  const packed = header[10] ?? 0;
  let position = 13 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0),
    frames = 0;
  const subblocks = async () => {
    while (true) {
      const size = (await reader.at(position++, 1))[0] ?? 0;
      if (!size) return;
      position += size;
    }
  };
  while (position < bytes) {
    const type = (await reader.at(position++, 1))[0];
    if (type === 59) {
      requireContext(
        frames === 1 && position === bytes,
        "invalid_image",
        "GIF must contain one complete frame",
      );
      return;
    }
    if (type === 33) {
      await reader.at(position++, 1);
      await subblocks();
    } else if (type === 44) {
      requireContext(++frames === 1, "invalid_image", "Animated GIF uploads are not supported");
      const descriptor = await reader.at(position, 9);
      position += 9;
      const flags = descriptor[8] ?? 0;
      if (flags & 128) position += 3 * 2 ** ((flags & 7) + 1);
      const code = (await reader.at(position++, 1))[0] ?? 0;
      requireContext(code >= 2 && code <= 8, "invalid_image", "Invalid GIF compression code size");
      await subblocks();
    } else requireContext(false, "invalid_image", "Unknown GIF block");
  }
  requireContext(false, "invalid_image", "GIF has no trailer");
}
async function webp(reader: Reader, bytes: number): Promise<void> {
  let position = 12,
    images = 0;
  while (position < bytes) {
    const header = await reader.at(position, 8);
    const type = header.subarray(0, 4).toString("ascii"),
      length = header.readUInt32LE(4);
    requireContext(
      position + length + 8 <= bytes && type !== "ANIM" && type !== "ANMF",
      "invalid_image",
      "Invalid or animated WebP container",
    );
    if (type === "VP8 " || type === "VP8L") images++;
    position += 8 + length + (length & 1);
  }
  requireContext(
    position === bytes && images === 1,
    "invalid_image",
    "WebP must contain one complete image",
  );
}
export async function validateImageContainer(
  path: string,
  mime: string,
  bytes: number,
): Promise<void> {
  if (mime !== "image/png" && mime !== "image/gif" && mime !== "image/webp") return;
  const file = await open(path, "r");
  try {
    const reader = new Reader(file, bytes);
    if (mime === "image/png") await png(reader, bytes);
    else if (mime === "image/gif") await gif(reader, bytes);
    else await webp(reader, bytes);
  } finally {
    await file.close();
  }
}
