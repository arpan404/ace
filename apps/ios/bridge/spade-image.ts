import type { ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { spadeRefusal, type SpadeImageRef } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { base64 } from "./bytes.ts";
import type { NativeAttachment } from "./native-attachment.ts";
import type { AttachmentLine } from "./thread-rows.ts";

/*
 * A picture in a Spade conversation, as the iPhone draws a thread message's (ADR 0134): each
 * image is an `AttachmentLine` named by its hash, and its bytes are read from Spade by that hash
 * (`GET /v1/images/{sha256}`, through the daemon) in `native.attachment`'s shape, so Swift
 * decodes, caches and opens it exactly as it does a thread's.
 */

export const SpadeImageRequest = z.object({
  type: z.literal("spade.image"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

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
  id: () => string,
  sha256: string,
  signal: AbortSignal,
): Promise<NativeAttachment> {
  const answer = await spadeExchange(
    owner,
    { method: "GET", path: `/v1/images/${sha256}` },
    { id, signal },
  );
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
