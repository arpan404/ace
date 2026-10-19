/*
 * How much a message may carry, checked before anything uploads. These match the daemon's
 * defaults; the daemon enforces its configured limits again when the file arrives.
 */

export const attachmentLimits = {
  /** One file. */
  fileBytes: 512 * 1024 * 1024,
  /** All of one message's files together. */
  messageBytes: 1024 * 1024 * 1024,
  /** Files one message carries (`MessageContext.attachments`). */
  perMessage: 64,
} as const;

/**
 * Why a file of `bytes` can't join a message already holding `heldBytes`, in words (binary
 * units, as the daemon sets them), or undefined when it fits.
 */
export function attachmentSizeProblem(bytes: number, heldBytes: number): string | undefined {
  if (bytes > attachmentLimits.fileBytes) return "Too large: files can be up to 512 MB each";
  if (heldBytes + bytes > attachmentLimits.messageBytes)
    return "Too much for one message: files can add up to 1 GB";
  return undefined;
}
