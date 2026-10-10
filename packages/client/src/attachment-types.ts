export interface AttachmentInput {
  threadId: string;
  sha256: string;
  variant?: "original" | "thumbnail";
  /** Originals require an explicit caller budget. Previews default to 256 KiB. */
  maxBytes?: number;
}
export type AttachmentFrame = { bytes: number; mimeType: string } | Uint8Array;
