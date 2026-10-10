import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { BlobLease } from "./blob-leases.ts";
import { requireContext } from "./errors.ts";

/** A verified, thread-owned original stays leased for the entire paced download. */
export async function attachmentDownload(
  lease: BlobLease,
  maxBytes: number,
  access: () => boolean,
) {
  let release = async () => lease.release();
  try {
    const blob = lease.blobs[0];
    requireContext(blob, "not_found", "Attachment unavailable");
    const attachment = blob.attachment;
    requireContext(
      Number.isSafeInteger(maxBytes) &&
        maxBytes > 0 &&
        maxBytes <= 32 * 1024 * 1024 &&
        blob.attachment.bytes <= maxBytes,
      "quota",
      "Attachment exceeds caller budget",
    );
    const assert = () => requireContext(access(), "forbidden", "Thread read permission revoked");
    assert();
    const file = await open(blob.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        try {
          await file.close();
        } finally {
          lease.release();
        }
      })());
    release = close;
    async function* read() {
      try {
        let offset = 0;
        while (offset < attachment.bytes) {
          assert();
          const bytes = Buffer.alloc(Math.min(65536, attachment.bytes - offset));
          let filled = 0;
          while (filled < bytes.length) {
            const result = await file.read(bytes, filled, bytes.length - filled, offset + filled);
            requireContext(result.bytesRead > 0, "not_found", "Attachment truncated");
            filled += result.bytesRead;
          }
          assert();
          offset += bytes.length;
          yield bytes;
        }
      } finally {
        await close();
      }
    }
    const chunks = read();
    assert();
    return {
      size: blob.attachment.bytes,
      offset: 0,
      validator: blob.attachment.sha256,
      mimeType: blob.attachment.mimeType,
      chunks,
      async close() {
        await chunks.return(undefined);
        await close();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
