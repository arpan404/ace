import { validateImageContainer } from "./image-container.ts";
import { imageSize } from "image-size";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ContextError, requireContext } from "./errors.ts";

export interface ImageLimits {
  maxSide: number;
  maxPixels: number;
}
export const defaultImageLimits: ImageLimits = { maxSide: 16_384, maxPixels: 40_000_000 };
export function sniffMime(header: Uint8Array): string {
  const b = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  if (b.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  try {
    if (b.includes(0)) return "application/octet-stream";
    new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: true });
    return "text/plain";
  } catch {
    return "application/octet-stream";
  }
}
const dimensions = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  type: z.string(),
});
export function inspectImage(
  header: Buffer,
  trailer: Buffer,
  bytes: number,
  limits = defaultImageLimits,
): { mimeType: string; width?: number; height?: number } {
  const mimeType = sniffMime(header);
  if (!mimeType.startsWith("image/")) return { mimeType };
  let size: z.infer<typeof dimensions>;
  try {
    size = dimensions.parse(imageSize(header));
  } catch {
    throw new ContextError("invalid_image", "Image header could not be validated");
  }
  requireContext(
    size.width <= limits.maxSide &&
      size.height <= limits.maxSide &&
      size.width * size.height <= limits.maxPixels,
    "invalid_image",
    "Image dimensions exceed safety limits",
  );
  if (mimeType === "image/png") {
    requireContext(
      header.length >= 33 &&
        header.readUInt32BE(8) === 13 &&
        header.subarray(12, 16).toString() === "IHDR" &&
        header[26] === 0 &&
        header[27] === 0 &&
        (header[28] === 0 || header[28] === 1) &&
        bytes >= 57 &&
        trailer.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex")),
      "invalid_image",
      "Incomplete or malformed PNG",
    );
  } else if (mimeType === "image/jpeg") {
    requireContext(
      trailer.subarray(-2).equals(Buffer.from([255, 217])),
      "invalid_image",
      "Incomplete JPEG",
    );
  } else if (mimeType === "image/gif") {
    requireContext(trailer.at(-1) === 59, "invalid_image", "Incomplete GIF");
  } else {
    requireContext(
      header.length >= 12 && header.readUInt32LE(4) + 8 === bytes,
      "invalid_image",
      "Invalid WebP container length",
    );
  }
  return { mimeType, width: size.width, height: size.height };
}
export async function inspectBlob(
  path: string,
  limits: ImageLimits,
): Promise<{ sha256: string; bytes: number; mimeType: string; width?: number; height?: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(Math.min(bytes, 64 * 1024));
    const trailer = Buffer.alloc(Math.min(bytes, 12));
    await file.read(header, 0, header.length, 0);
    await file.read(trailer, 0, trailer.length, bytes - trailer.length);
    const image = inspectImage(header, trailer, bytes, limits);
    await validateImageContainer(path, image.mimeType, bytes);
    return { sha256: hash.digest("hex"), bytes, ...image };
  } finally {
    await file.close();
  }
}
