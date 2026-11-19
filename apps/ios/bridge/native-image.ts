import { attachmentBytes, type ClientCore } from "@ace/client";
import { ItemId, ThreadId } from "@ace/protocol";
import { z } from "zod";

import { base64 } from "./bytes.ts";

/*
 * An image an agent's Markdown names (`![chart](./chart.png)`), for the phone to draw inline. As
 * on the web, the daemon resolves the reference to a picture the thread itself captured (an image
 * a tool read or made, before the message naming it), and only those bytes come back, through the
 * owning connection. The phone never fetches a URL from prose.
 */

export const NativeImageRequest = z.object({
  type: z.literal("native.image"),
  threadId: ThreadId,
  /** The message naming it: only images captured before it, by its own agent, resolve. */
  itemId: ItemId.optional(),
  reference: z.string().min(1).max(4096),
});
export type NativeImageRequest = z.infer<typeof NativeImageRequest>;

/** The most of one picture the phone reads to draw it in a message. */
const imageLimit = 16 * 1024 * 1024;
const drawn = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function readNativeImage(
  owner: ClientCore,
  request: NativeImageRequest,
  signal: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  const reply = await owner.request(
    {
      type: "context.request",
      operation: {
        op: "image.resolve",
        threadId: request.threadId,
        reference: request.reference,
        ...(request.itemId ? { itemId: request.itemId } : {}),
      },
    },
    { signal },
  );
  if (reply.result.kind !== "attachment") throw new Error("Image unavailable");
  const { attachment } = reply.result;
  if (attachment.bytes > imageLimit) throw new Error("Image too large to show here");
  const read = await attachmentBytes(
    owner,
    {
      threadId: request.threadId,
      sha256: attachment.sha256,
      variant: "original",
      maxBytes: imageLimit,
    },
    { signal },
  );
  if (!drawn.has(read.mimeType)) throw new Error("Image unavailable");
  return { mimeType: read.mimeType, data: base64(read.bytes) };
}
