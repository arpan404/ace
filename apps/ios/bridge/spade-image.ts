import type { ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { maxSpadeImageBytes } from "@ace/protocol";
import { spadeRefusal, type SpadeImageRef } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { base64 } from "./bytes.ts";
import type { ImageBudget } from "./image-budget.ts";
import type { NativeAttachment } from "./native-attachment.ts";
import type { AttachmentLine } from "./thread-rows.ts";

/*
 * A picture in a Spade conversation, as the iPhone draws a thread message's (ADR 0134): each
 * image is an `AttachmentLine` named by its hash, and its bytes are read by that hash through the
 * daemon in `native.attachment`'s shape, so Swift decodes, caches and opens it exactly as it does
 * a thread's. A thumbnail is the daemon's preview (`?preview`, at most 512 pixels a side); the
 * viewer reads the image itself. Reads share the phone's budget of image bytes in flight.
 */

export const SpadeImageRequest = z.object({
  type: z.literal("spade.image"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** `thumbnail`: the daemon's small preview; `original`: the picture itself. */
  variant: z.enum(["thumbnail", "original"]),
});
export type SpadeImageRequest = z.infer<typeof SpadeImageRequest>;

/** Base64 of the most one read can bring: a 512-pixel PNG preview, or a whole stored image. */
const inFlight = {
  thumbnail: Math.ceil((1024 * 1024 * 4) / 3),
  original: Math.ceil((maxSpadeImageBytes * 4) / 3),
};
/** A message's images as its bubble draws them; Spade doesn't say their shape. */
export function spadeImageLines(images: readonly SpadeImageRef[]): AttachmentLine[] {
  return images.map((image) => ({
    kind: "image",
    name: "Image",
    ref: image.sha256,
    mimeType: image.mediaType,
    bytes: image.bytes,
    width: 0,
    height: 0,
    thumbnail: true,
    opens: true,
  }));
}

/** The picture's bytes as base64, with Spade's media type; throws when Spade can't give it. */
export async function readSpadeImage(
  owner: ClientCore,
  budget: ImageBudget,
  id: () => string,
  request: SpadeImageRequest,
  signal: AbortSignal,
): Promise<NativeAttachment> {
  const path = `/v1/images/${request.sha256}${request.variant === "thumbnail" ? "?preview" : ""}`;
  return budget.run(inFlight[request.variant], () => readImage(owner, id, path, signal));
}

async function readImage(
  owner: ClientCore,
  id: () => string,
  path: string,
  signal: AbortSignal,
): Promise<NativeAttachment> {
  const answer = await spadeExchange(owner, { method: "GET", path }, { id, signal });
  if (answer.kind === "error") throw new Error(answer.message);
  if (answer.status < 200 || answer.status > 299)
    throw new Error(spadeRefusal(answer.status, answer.encoding === "text" ? answer.body : ""));
  const data =
    answer.encoding === "base64" ? answer.body : base64(new TextEncoder().encode(answer.body));
  return {
    kind: "image",
    name: "Image",
    mimeType: answer.contentType ?? "image/png",
    data,
  };
}
