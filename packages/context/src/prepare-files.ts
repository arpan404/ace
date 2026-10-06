import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import type { BlobLease } from "./blob-leases.ts";
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
/** Read only bounded text prefixes or negotiated native payloads; binaries stay on disk. */
export async function prepareFiles(
  blobs: BlobLease["blobs"],
  capabilities: ProjectionCapabilities,
): Promise<PreparedAttachment[]> {
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
    if (
      attachment.text === undefined &&
      info.bytes <= nativeRemaining &&
      (image || document) &&
      capabilities.provider !== "codex"
    ) {
      attachment.base64 = (await prefix(blob.path, info.bytes)).toString("base64");
      nativeRemaining -= info.bytes;
    }
    result.push(attachment);
  }
  return result;
}
