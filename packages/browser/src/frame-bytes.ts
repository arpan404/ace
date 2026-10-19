import type { BrowserFrame } from "@ace/protocol";

const decoded = new WeakMap<BrowserFrame, Buffer>();

/**
 * A frame's JPEG bytes, decoded from base64 once however many viewers and recordings take it.
 * Callers never write to the buffer: it is shared.
 */
export function frameBytes(frame: BrowserFrame): Buffer {
  let bytes = decoded.get(frame);
  if (!bytes) {
    bytes = Buffer.from(frame.data, "base64");
    decoded.set(frame, bytes);
  }
  return bytes;
}
