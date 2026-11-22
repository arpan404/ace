import type { ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { maxSpadeImageBytes } from "@ace/protocol";
import {
  spadeRefusal,
  type SpadeDocumentRef,
  type SpadeImageRef,
  type SpadeVoiceRef,
} from "@ace/ui-core/spade-chat";
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
 *
 * A document is a file line that opens in Quick Look (`spade.document`, its ref `document:` and
 * the hash, so it never reads as a picture), and a recording is read to play (`spade.audio`).
 */

export const SpadeImageRequest = z.object({
  type: z.literal("spade.image"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** `thumbnail`: the daemon's small preview; `original`: the picture itself. */
  variant: z.enum(["thumbnail", "original"]),
});
export type SpadeImageRequest = z.infer<typeof SpadeImageRequest>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A document a message carries, by its hash, to open; `name` is what it is saved as. */
export const SpadeDocumentRequest = z.object({
  type: z.literal("spade.document"),
  sha256,
  name: z.string().min(1).max(255),
});
/** A voice message's recording, by its hash, to play. */
export const SpadeAudioRequest = z.object({ type: z.literal("spade.audio"), sha256 });

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

/** A message's documents as file lines that open: read by hash with `spade.document`. */
export function spadeDocumentLines(documents: readonly SpadeDocumentRef[]): AttachmentLine[] {
  return documents.map((document) => ({
    kind:
      document.mediaType === "application/pdf"
        ? "pdf"
        : document.mediaType.startsWith("text/")
          ? "text"
          : "file",
    name: document.name,
    ref: `document:${document.sha256}`,
    mimeType: document.mediaType,
    bytes: document.bytes,
    width: 0,
    height: 0,
    thumbnail: false,
    opens: true,
  }));
}

/** A voice message's recording as the phone plays it, read by hash with `spade.audio`. */
export interface SpadeVoiceLine {
  ref: string;
  mimeType: string;
  bytes: number;
}
export const spadeVoiceLine = (voice: SpadeVoiceRef | undefined): SpadeVoiceLine | null =>
  voice ? { ref: voice.sha256, mimeType: voice.mediaType, bytes: voice.bytes } : null;

/** A stored document's or recording's bytes as base64; throws when Spade can't give them. */
export async function readSpadeFile(
  owner: ClientCore,
  id: () => string,
  request: z.infer<typeof SpadeDocumentRequest> | z.infer<typeof SpadeAudioRequest>,
  signal: AbortSignal,
): Promise<NativeAttachment> {
  const [path, name] =
    request.type === "spade.document"
      ? [`/v1/documents/${request.sha256}?name=${encodeURIComponent(request.name)}`, request.name]
      : [`/v1/audio/${request.sha256}`, "Voice message"];
  const read = await readBytes(owner, id, path, "application/octet-stream", signal);
  return { kind: "file", name, ...read };
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
  return budget.run(inFlight[request.variant], async () => ({
    kind: "image",
    name: "Image",
    ...(await readBytes(owner, id, path, "image/png", signal)),
  }));
}

/** Spade's answer to a read, as base64 with its media type (`fallback` when it names none). */
async function readBytes(
  owner: ClientCore,
  id: () => string,
  path: string,
  fallback: string,
  signal: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  const answer = await spadeExchange(owner, { method: "GET", path }, { id, signal });
  if (answer.kind === "error") throw new Error(answer.message);
  if (answer.status < 200 || answer.status > 299)
    throw new Error(spadeRefusal(answer.status, answer.encoding === "text" ? answer.body : ""));
  const data =
    answer.encoding === "base64" ? answer.body : base64(new TextEncoder().encode(answer.body));
  return { mimeType: answer.contentType ?? fallback, data };
}
