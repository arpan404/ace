import { attachmentBytes, listThreadAttachments, type ClientCore } from "@ace/client";
import { BlobHash, ItemId, ThreadId, type Attachment } from "@ace/protocol";
import { z } from "zod";

import {
  drawnAsPicture,
  heicOriginalLimit,
  originalStandsIn,
  pictureBytes,
} from "./attachment-picture.ts";
import { base64 } from "./bytes.ts";
import type { ImageBudget } from "./image-budget.ts";
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
  /** The message carrying it; absent for a file of the thread's own list (Attachments). */
  itemId: ItemId.optional(),
  ref: z.union([BlobHash, z.string().regex(/^part:\d{1,3}$/)]),
  /** `thumbnail` is the daemon's bounded preview; `original` the file itself. */
  variant: z.enum(["thumbnail", "original"]),
});
export type NativeAttachmentRequest = z.infer<typeof NativeAttachmentRequest>;

/** The most of one file the phone fetches to open it (the SDK's own ceiling). */
const originalLimit = 32 * 1024 * 1024;
/** The most a daemon preview holds (`@ace/context`'s preview limit). */
const previewBytes = 512 * 1024;
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
  /** The Attachments list the person is looking at, so a listed file isn't listed again. */
  listed?: { find(threadId: string, sha256: string): Attachment | undefined },
  /** The phone's budget of image bytes in flight; unbounded when absent (a test's one read). */
  images?: ImageBudget,
): Promise<NativeAttachment> {
  if (!request.itemId) {
    // Only a file the thread itself stores, as its Attachments list names it.
    if (request.ref.startsWith("part:")) throw new Error("Attachment unavailable");
    const known = listed?.find(request.threadId, request.ref);
    if (known) return readStored(owner, request, known, signal, images);
    const files = await listThreadAttachments(
      request.threadId,
      async (operation) =>
        (await owner.request({ type: "context.request", operation }, { signal })).result,
      () => {
        throw new Error("Attachment unavailable");
      },
    );
    const stored = files.find((file) => file.sha256 === request.ref);
    if (!stored) throw new Error("Attachment unavailable");
    return readStored(owner, request, stored, signal, images);
  }
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
  return readStored(owner, request, attachment, signal, images);
}

/** A stored file's preview or bytes, once the caller has shown the thread holds it. */
async function readStored(
  owner: ClientCore,
  request: NativeAttachmentRequest,
  attachment: Attachment,
  signal: AbortSignal,
  images: ImageBudget | undefined,
): Promise<NativeAttachment> {
  const thumbnail = request.variant === "thumbnail";
  // A file without a preview is never downloaded whole just to draw a row, except a small HEIC
  // the daemon couldn't preview, which the phone decodes itself (`attachment-picture.ts`).
  const standIn = thumbnail && originalStandsIn(attachment);
  if (thumbnail && !attachment.thumbnailAvailable && !standIn) throw new Error("No preview");
  if (!thumbnail && attachment.bytes > originalLimit) throw new Error("Too large to open here");
  const read = (variant: "thumbnail" | "original", maxBytes: number | undefined) =>
    attachmentBytes(
      owner,
      {
        threadId: request.threadId,
        sha256: attachment.sha256,
        variant,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      },
      { signal },
    );
  const original = () => read("original", thumbnail ? heicOriginalLimit : originalLimit);
  const fetch = () =>
    thumbnail && attachment.thumbnailAvailable
      ? read("thumbnail", undefined).catch((error: unknown) => {
          if (!standIn || signal.aborted) throw error;
          return original();
        })
      : original();
  // Counted at the most it may bring as base64: a preview, or the original whole.
  const most = Math.ceil(
    ((thumbnail && !standIn ? previewBytes : Math.max(attachment.bytes, previewBytes)) * 4) / 3,
  );
  const result = images ? await images.run(most, fetch) : await fetch();
  // Only bytes that begin as a picture are ever handed to the phone's decoder.
  const picture =
    drawnAsPicture({ mimeType: result.mimeType, name: attachment.name }) &&
    pictureBytes(result.bytes);
  if (thumbnail && !picture) throw new Error("Not a picture");
  return {
    kind: picture ? "image" : "file",
    name: attachment.name,
    mimeType: result.mimeType,
    data: base64(result.bytes),
  };
}
