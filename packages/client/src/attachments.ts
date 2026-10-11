import { attachmentBudget, attachmentChunks } from "./attachment-reader.ts";
import { ClientError, type RequestOptions } from "./types.ts";
import type { ContextResult } from "@ace/protocol";
import type { AttachmentInput, AttachmentFrame } from "./attachment-types.ts";
export { attachmentChunks } from "./attachment-reader.ts";
export type { AttachmentInput, AttachmentFrame } from "./attachment-types.ts";
type AttachmentClient = {
  request(
    input: {
      type: "context.request";
      operation: {
        op: "attachment.read";
        threadId: import("@ace/protocol").ThreadId;
        sha256: string;
        variant: "original" | "thumbnail";
        offset: number;
        limit: number;
      };
    },
    options?: RequestOptions,
  ): Promise<ContextResult>;
  attachmentChunks?(
    input: AttachmentInput,
    options: RequestOptions,
  ): AsyncGenerator<AttachmentFrame>;
};
/** Uses the owning connection's authenticated request path, including encrypted relays. */
export async function attachmentBytes(
  client: AttachmentClient,
  input: AttachmentInput,
  options: RequestOptions = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const max = attachmentBudget(input);
  const frames =
    input.variant === "original" && client.attachmentChunks
      ? client.attachmentChunks(input, options)
      : attachmentChunks(client, input, options);
  let bytes: Uint8Array | undefined,
    mimeType: string | undefined,
    offset = 0;
  for await (const frame of frames) {
    if (frame instanceof Uint8Array) {
      if (!bytes || !frame.length || frame.length > 65536 || offset + frame.length > bytes.length)
        throw new ClientError("protocol");
      bytes.set(frame, offset);
      offset += frame.length;
    } else {
      if (
        bytes ||
        !Number.isSafeInteger(frame.bytes) ||
        frame.bytes < 0 ||
        frame.bytes > max ||
        typeof frame.mimeType !== "string" ||
        !frame.mimeType ||
        frame.mimeType.length > 128
      )
        throw new ClientError("protocol", "Attachment scope or size mismatch");
      bytes = new Uint8Array(frame.bytes);
      mimeType = frame.mimeType;
    }
  }
  if (!bytes || !mimeType || offset !== bytes.length) throw new ClientError("protocol");
  return { bytes, mimeType };
}
