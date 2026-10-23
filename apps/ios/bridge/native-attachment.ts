import { attachmentBytes, type ClientCore } from "@ace/client";
import { BlobHash, ItemId, ThreadId } from "@ace/protocol";
import { z } from "zod";

import { base64 } from "./bytes.ts";
import { readNativeItem } from "./native-item.ts";

/*
 * The bytes of one file or image a person's message carried, for its thumbnail in the bubble,
 * the full-screen viewer or Quick Look. The caller names the message and which of its files
 * (`AttachmentLine.ref`): a stored attachment by hash, or an inline image part by position. Only
 * what that message itself carries resolves, through the owning connection; never a URL.
 */

export const NativeAttachmentRequest = z.object({
  type: z.literal("native.attachment"),
  threadId: ThreadId,
  itemId: ItemId,
  ref: z.union([BlobHash, z.string().regex(/^part:\d{1,3}$/)]),
  /** `thumbnail` is the daemon's bounded preview; `original` the file itself. */
  variant: z.enum(["thumbnail", "original"]),
});
export type NativeAttachmentRequest = z.infer<typeof NativeAttachmentRequest>;

/** The most of one file the phone fetches to open it (the SDK's own ceiling). */
const originalLimit = 32 * 1024 * 1024;
const shownImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Inline image data a message part may carry: base64 of an image type the phone decodes. */
const inlineImage = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/;

export interface NativeAttachment {
  /** `image` when the bytes are a picture the phone shows; `file` otherwise. */
  kind: "image" | "file";
  name: string;
  mimeType: string;
  data: string;
}

export async function readNativeAttachment(
  owner: ClientCore,
  request: NativeAttachmentRequest,
  signal: AbortSignal,
): Promise<NativeAttachment> {
  // Another thread's item, or one the daemon refuses, simply has no files here.
  const item = await readNativeItem(owner, request.threadId, request.itemId, signal).catch(
    (error: unknown) => {
      if (signal.aborted) throw error;
      return undefined;
    },
  );
  if (item?.type !== "message") throw new Error("Attachment unavailable");
  if (request.ref.startsWith("part:")) {
    const part = item.parts[Number(request.ref.slice(5))];
    const inline = part?.type === "image" ? inlineImage.exec(part.url) : null;
    const [, mimeType, data] = inline ?? [];
    if (!mimeType || !data) throw new Error("Attachment unavailable");
    return { kind: "image", name: "Image", mimeType, data };
  }
  const attachment = item.attachments?.find((file) => file.sha256 === request.ref);
  if (!attachment) throw new Error("Attachment unavailable");
  const thumbnail = request.variant === "thumbnail";
  // A file without a preview is never downloaded whole just to draw a row.
  if (thumbnail && !attachment.thumbnailAvailable) throw new Error("No preview");
  if (!thumbnail && attachment.bytes > originalLimit) throw new Error("Too large to open here");
  const result = await attachmentBytes(
    owner,
    {
      threadId: request.threadId,
      sha256: attachment.sha256,
      variant: request.variant,
      ...(thumbnail ? {} : { maxBytes: originalLimit }),
    },
    { signal },
  );
  return {
    kind: shownImages.has(result.mimeType) ? "image" : "file",
    name: attachment.name,
    mimeType: result.mimeType,
    data: base64(result.bytes),
  };
}
