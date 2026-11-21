import { encodePicture } from "./stream-encode.ts";
import type { PictureChunk, PictureKind } from "./stream-picture.ts";

/**
 * One screenshot's binary messages: a still, outside every live view and never acked. The
 * daemon sends a person's screenshot this way; live pictures only ever come from ace-media
 * (X3), so this is the one picture envelope the daemon writes.
 */
export function encodeStill(
  kind: PictureKind,
  id: number,
  sourceId: string,
  chunk: Omit<PictureChunk, "bytes" | "still">,
  bytes: Uint8Array,
): Uint8Array[] {
  return encodePicture(kind, id, sourceId, { ...chunk, still: true }, bytes);
}
