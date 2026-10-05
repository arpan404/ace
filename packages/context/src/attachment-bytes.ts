import { constants } from "node:fs";
import { link, open } from "node:fs/promises";
import sharp from "sharp";
import type { Attachment } from "@ace/protocol";
import { requireContext } from "./errors.ts";

const extensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};
export function mediaExtension(mime: string): string {
  return extensions[mime] ?? "";
}
export function hasThumbnail(mime: string): boolean {
  return mime.startsWith("image/") && mediaExtension(mime) !== "";
}
/** Hard links keep the verified original bytes, including alpha and colour profiles. */
export async function providerImagePath(path: string, mime: string): Promise<string> {
  const extension = mediaExtension(mime);
  if (!extension) return path;
  const alias = path + extension;
  try {
    await link(path, alias);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return alias;
}
export const previewLimit = 256 * 1024;
export async function renderThumbnail(path: string): Promise<Buffer> {
  return sharp(path, { limitInputPixels: 40_000_000, sequentialRead: true, animated: false })
    .rotate()
    .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}
/** Originals are read in bounded ranges; previews have independent byte and pixel bounds. */
export class AttachmentBytes {
  private previews = 0;
  private cache = new Map<string, Buffer>();
  private render: (path: string) => Promise<Buffer>;
  constructor(render: (path: string) => Promise<Buffer> = renderThumbnail) {
    this.render = render;
  }
  async read(
    blob: { path: string; attachment: Attachment },
    variant: "original" | "thumbnail",
    offset: number,
    limit: number,
  ) {
    requireContext(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 65536,
      "invalid_request",
      "Invalid attachment range",
    );
    if (variant === "thumbnail") {
      requireContext(
        hasThumbnail(blob.attachment.mimeType),
        "unsupported",
        "Attachment has no thumbnail",
      );
      requireContext(this.previews < 2, "busy", "Thumbnail decoder busy");
      this.previews++;
      try {
        let data = this.cache.get(blob.attachment.sha256);
        data ??= await this.render(blob.path);
        requireContext(data.length <= previewLimit, "quota", "Thumbnail exceeds byte limit");
        this.cache.delete(blob.attachment.sha256);
        this.cache.set(blob.attachment.sha256, data);
        while (this.cache.size > 8) {
          const key = this.cache.keys().next().value;
          if (key === undefined) break;
          this.cache.delete(key);
        }

        requireContext(offset <= data.length, "offset", "Range outside attachment");
        return {
          mimeType: "image/png",
          bytes: data.length,
          data: data.subarray(offset, offset + limit),
        };
      } finally {
        this.previews--;
      }
    }
    requireContext(offset <= blob.attachment.bytes, "offset", "Range outside attachment");
    const file = await open(blob.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const data = Buffer.alloc(Math.min(limit, blob.attachment.bytes - offset));
      let read = 0;
      while (read < data.length) {
        const result = await file.read(data, read, data.length - read, offset + read);
        requireContext(result.bytesRead > 0, "not_found", "Attachment truncated");
        read += result.bytesRead;
      }
      return { mimeType: blob.attachment.mimeType, bytes: blob.attachment.bytes, data };
    } finally {
      await file.close();
    }
  }
}
