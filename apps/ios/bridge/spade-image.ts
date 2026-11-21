import type { ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { maxSpadeImageBytes } from "@ace/protocol";
import { spadeRefusal, type SpadeImageRef } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { base64 } from "./bytes.ts";
import type { NativeAttachment } from "./native-attachment.ts";
import type { AttachmentLine } from "./thread-rows.ts";

/*
 * A picture in a Spade conversation, as the iPhone draws a thread message's (ADR 0134): each
 * image is an `AttachmentLine` named by its hash, and its bytes are read by that hash through the
 * daemon in `native.attachment`'s shape, so Swift decodes, caches and opens it exactly as it does
 * a thread's. A thumbnail is the daemon's preview (`?preview`, at most 512 pixels a side); the
 * viewer reads the image itself. Reads share a budget of bytes in flight.
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
/** Base64 the phone's reads may hold in flight at once: a dozen previews, or two originals. */
export const spadeImageBudgetBytes = 16 * 1024 * 1024;

/**
 * Reads that hold at most `cap` bytes between them, each counted at the most it may bring. They
 * start in the order they came; one larger than the cap runs once nothing else is in flight.
 */
export class SpadeImageBudget {
  private held = 0;
  private readonly cap: number;
  private readonly waiting: { bytes: number; start: () => void }[] = [];
  constructor(cap: number) {
    this.cap = cap;
  }

  async run<T>(bytes: number, read: () => Promise<T>): Promise<T> {
    // A read's bytes are counted the moment it is let in, whether at once or from the line.
    if (this.waiting.length || !this.fits(bytes))
      await new Promise<void>((start) => this.waiting.push({ bytes, start }));
    else this.held += bytes;
    try {
      return await read();
    } finally {
      this.held -= bytes;
      this.letIn();
    }
  }

  private fits(bytes: number) {
    return this.held === 0 || this.held + bytes <= this.cap;
  }

  private letIn() {
    for (let next = this.waiting[0]; next && this.fits(next.bytes); next = this.waiting[0]) {
      this.waiting.shift();
      this.held += next.bytes;
      next.start();
    }
  }
}

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
  budget: SpadeImageBudget,
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
