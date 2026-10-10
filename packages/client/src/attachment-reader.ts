import { BlobHash, ThreadId, type ContextResult } from "@ace/protocol";
import { decodeBase64 } from "./base64.ts";
import { ClientError, type RequestOptions } from "./types.ts";
import type { AttachmentInput, AttachmentFrame } from "./attachment-types.ts";
type Reader = {
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
};
export function attachmentBudget(input: AttachmentInput): number {
  ThreadId.parse(input.threadId);
  BlobHash.parse(input.sha256);
  if (input.variant === "original" && input.maxBytes === undefined) throw new ClientError("limit");
  const max = input.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(max) || max <= 0 || max > 32 * 1024 * 1024)
    throw new ClientError("limit");
  return max;
}
/** Portable fallback and thumbnails retain the bounded, authenticated context reader. */
export async function* attachmentChunks(
  client: Reader,
  input: AttachmentInput,
  options: RequestOptions = {},
): AsyncGenerator<AttachmentFrame> {
  const max = attachmentBudget(input);
  const threadId = ThreadId.parse(input.threadId),
    sha256 = BlobHash.parse(input.sha256);
  const variant = input.variant ?? "thumbnail";
  let offset = 0,
    size: number | undefined,
    mimeType: string | undefined;
  for (;;) {
    const reply = await client.request(
      {
        type: "context.request",
        operation: { op: "attachment.read", threadId, sha256, variant, offset, limit: 65536 },
      },
      options,
    );
    const result = reply.result;
    if (result.kind !== "attachment.data")
      throw new ClientError(
        result.kind === "error" && result.code === "busy" ? "busy" : "daemon",
        result.kind === "error" ? result.message : "Invalid attachment response",
      );
    if (
      result.sha256 !== sha256 ||
      result.variant !== variant ||
      result.offset !== offset ||
      result.bytes > max ||
      (size !== undefined && size !== result.bytes) ||
      (mimeType && mimeType !== result.mimeType)
    )
      throw new ClientError("protocol", "Attachment scope or size mismatch");
    if (size === undefined) {
      size = result.bytes;
      mimeType = result.mimeType;
      yield { bytes: size, mimeType };
    }
    const chunk = decodeBase64(result.data, 65536);
    if (offset + chunk.length > size || (!chunk.length && !result.eof))
      throw new ClientError("protocol");
    offset += chunk.length;
    if (chunk.length) yield chunk;
    if (result.eof) {
      if (offset !== size) throw new ClientError("protocol");
      return;
    }
  }
}
