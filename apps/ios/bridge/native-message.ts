import type { ClientCore } from "@ace/client";
import { ItemId, ThreadId, type TextSource } from "@ace/protocol";
import { z } from "zod";

export const NativeMessageRequest = z.object({
  type: z.literal("native.message"),
  threadId: ThreadId,
  itemId: ItemId,
});

/** Full prose is read on demand, from the item's authenticated source, never a caller URL. */
export async function readNativeMessage(
  owner: ClientCore,
  request: z.infer<typeof NativeMessageRequest>,
  signal: AbortSignal,
) {
  const item = owner.cachedThread(request.threadId)?.item(request.itemId);
  if (!item || (item.type !== "message" && item.type !== "reasoning"))
    throw new Error("Message unavailable");
  const parts: { text: string; source?: TextSource | undefined }[] =
    item.type === "reasoning" ? [item] : item.parts.filter((part) => part.type === "text");
  const limit = 4 * 1024 * 1024;
  if (
    parts.reduce(
      (sum, part) => sum + Math.max(part.text.length, (part.source?.bytes ?? 0) / 2),
      0,
    ) > limit
  )
    throw new Error("This message is too large to display on the phone");
  const output: string[] = [];
  let size = 0;
  for (const part of parts) {
    if (part.source && part.source.bytes > part.text.length * 2) {
      for await (const chunk of owner.text(part.source, { signal })) {
        size += chunk.length;
        if (size > limit) throw new Error("This message is too large to display on the phone");
        output.push(chunk);
      }
    } else {
      size += part.text.length;
      output.push(part.text);
    }
  }
  return { text: output.join("") };
}
