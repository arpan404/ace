import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import type { ImageWork } from "@ace/media/images";
import type { BlobLease } from "./blob-leases.ts";
import { modelImageCopy, modelImagesDeadlineMs, providerImageSide } from "./attachment-images.ts";
import { providerImagePath } from "./attachment-bytes.ts";
import { textEncoding, printableText } from "./file-kind.ts";
import { ContextError, requireContext } from "./errors.ts";
import type { PreparedAttachment, ProjectionCapabilities } from "./projection.ts";

async function prefix(path: string, length: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = await file.read(bytes, offset, length - offset, offset);
      requireContext(
        read.bytesRead > 0,
        "not_found",
        "Attachment is unreadable. Upload the file again.",
      );
      offset += read.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}
/**
 * Read only bounded text prefixes or negotiated native payloads; binaries stay on disk. An
 * image an inline provider couldn't take (over its remaining budget, or past what a provider
 * accepts a side) goes as a JPEG copy ace-media fits within both, when `images` is given.
 */
export async function prepareFiles(
  blobs: BlobLease["blobs"],
  capabilities: ProjectionCapabilities,
  /** ace-media's image work and the clock the turn's one fitting deadline is on. */
  images?: { work: ImageWork; now: () => number },
): Promise<PreparedAttachment[]> {
  const fitting = images && {
    now: images.now,
    deadlineAt: images.now() + modelImagesDeadlineMs,
  };
  const result: PreparedAttachment[] = [];
  let nativeRemaining = capabilities.maxInlineBytes;
  let textRemaining = 64 * 1024;
  for (const blob of blobs) {
    await access(blob.path, constants.R_OK).catch(() => {
      throw new ContextError("not_found", "Attachment is unreadable. Upload the file again.");
    });
    const info = blob.attachment;
    const attachment: PreparedAttachment = {
      path: await providerImagePath(blob.path, info.mimeType),
      name: info.name,
      mimeType: info.mimeType,
      bytes: info.bytes,
      nativeImage: info.kind === "image" || (info.kind === undefined && info.width !== undefined),
    };
    if (
      (info.kind === "text" || (info.kind === undefined && info.mimeType === "text/plain")) &&
      textRemaining > 0
    ) {
      const length = Math.min(info.bytes, 16 * 1024, textRemaining);
      const bytes = await prefix(blob.path, length);
      try {
        const text = new TextDecoder(textEncoding(bytes), { fatal: true }).decode(bytes, {
          stream: length < info.bytes,
        });
        if (printableText(text)) {
          attachment.text = text;
          attachment.truncated = length < info.bytes;
          textRemaining -= length;
        }
      } catch {
        /* Older blob metadata can label a binary prefix as text; use its path. */
      }
    }
    const image = attachment.nativeImage && capabilities.images.includes(info.mimeType);
    const document =
      capabilities.documents.includes(info.mimeType) || capabilities.documents.includes("*");
    // Codex and OpenCode read stored files by path; only inline providers need the bytes.
    const inline = capabilities.provider !== "codex" && capabilities.provider !== "opencode";
    const oversized =
      info.bytes > nativeRemaining ||
      Math.max(info.width ?? 0, info.height ?? 0) > providerImageSide;
    if (attachment.text === undefined && !oversized && (image || document) && inline) {
      attachment.base64 = (await prefix(blob.path, info.bytes)).toString("base64");
      nativeRemaining -= info.bytes;
    } else if (
      attachment.text === undefined &&
      image &&
      inline &&
      images &&
      capabilities.images.includes("image/jpeg") &&
      nativeRemaining > 0
    ) {
      const copy =
        fitting && (await modelImageCopy(images.work, blob.path, nativeRemaining, fitting));
      if (copy) {
        attachment.base64 = copy.toString("base64");
        attachment.mimeType = "image/jpeg";
        nativeRemaining -= copy.length;
      }
    }
    result.push(attachment);
  }
  return result;
}
