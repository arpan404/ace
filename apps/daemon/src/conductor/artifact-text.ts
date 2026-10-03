import type { Item } from "@ace/protocol";
import type { Store } from "../store.ts";

const limit = 1_048_576;
/** Text previews are never artifact inputs. Fetch at most two MiB of UTF-16 source
 * bytes, in the Store's bounded ranges, then enforce the UTF-8 artifact budget. */
export function readArtifactText(
  store: Store,
  message: Extract<Item, { type: "message" }>,
): string | undefined {
  let sourceBytes = 0;
  let utf8Bytes = 0;
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    let text = part.text;
    if (part.source) {
      sourceBytes += part.source.bytes;
      if (sourceBytes > limit * 2 || part.source.bytes % 2) return undefined;
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < part.source.bytes) {
        const chunk = store.readOutputBytes(
          part.source.streamId,
          offset,
          Math.min(256 * 1024, part.source.bytes - offset),
        );
        if (!chunk.bytes.length || chunk.nextOffset > part.source.bytes) return undefined;
        chunks.push(chunk.bytes);
        offset = chunk.nextOffset;
      }
      text = Buffer.concat(chunks).toString("utf16le");
    } else {
      sourceBytes += text.length * 2;
      if (sourceBytes > limit * 2) return undefined;
    }
    utf8Bytes += Buffer.byteLength(text);
    if (utf8Bytes > limit) return undefined;
    parts.push(text);
  }
  return parts.join("");
}
