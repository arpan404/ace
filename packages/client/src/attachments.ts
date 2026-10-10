import { BlobHash, ThreadId, type ContextResult } from "@ace/protocol";
import { decodeBase64 } from "./base64.ts";
import { ClientError, type RequestOptions } from "./types.ts";
export interface AttachmentInput {
  threadId: string;
  sha256: string;
  variant?: "original" | "thumbnail";
  /** Originals require an explicit caller budget. Previews default to 256 KiB. */
  maxBytes?: number;
}
/** Uses the owning connection's authenticated request path, including encrypted relays. */
export async function attachmentBytes(
  client: {
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
  },
  input: AttachmentInput,
  options: RequestOptions = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const threadId = ThreadId.parse(input.threadId),
    sha256 = BlobHash.parse(input.sha256);
  const variant = input.variant ?? "thumbnail";
  if (variant === "original" && input.maxBytes === undefined) throw new ClientError("limit");
  const max = input.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(max) || max <= 0 || max > 32 * 1024 * 1024)
    throw new ClientError("limit");
  let offset = 0,
    bytes: Uint8Array | undefined,
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
      (bytes && bytes.length !== result.bytes) ||
      (mimeType && mimeType !== result.mimeType)
    )
      throw new ClientError("protocol", "Attachment scope or size mismatch");
    bytes ??= new Uint8Array(result.bytes);
    mimeType ??= result.mimeType;
    const chunk = decodeBase64(result.data, 65536);
    if (offset + chunk.length > bytes.length || (!chunk.length && !result.eof))
      throw new ClientError("protocol");
    bytes.set(chunk, offset);
    offset += chunk.length;
    if (result.eof) {
      if (offset !== bytes.length) throw new ClientError("protocol");
      return { bytes, mimeType };
    }
  }
}
