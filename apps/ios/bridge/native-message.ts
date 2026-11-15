import type { ClientCore } from "@ace/client";
import { ItemId, ThreadId, type TextSource } from "@ace/protocol";
import { z } from "zod";

import { readNativeItem } from "./native-item.ts";
import { bubbleWords } from "./thread-messages.ts";

export const NativeMessageRequest = z.object({
  type: z.literal("native.message"),
  threadId: ThreadId,
  itemId: ItemId,
  /** The bubble's words (`bubbleWords`) rather than the item's whole text. */
  bubble: z.boolean().optional(),
});

/** Full prose is read on demand, from the item's authenticated source, never a caller URL. */
export async function readNativeMessage(
  owner: ClientCore,
  request: z.infer<typeof NativeMessageRequest>,
  signal: AbortSignal,
) {
  const item = await readNativeItem(owner, request.threadId, request.itemId, signal);
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
      const chunks: string[] = [];
      for await (const chunk of owner.text(part.source, { signal })) {
        size += chunk.length;
        if (size > limit) throw new Error("This message is too large to display on the phone");
        chunks.push(chunk);
      }
      output.push(chunks.join(""));
    } else {
      size += part.text.length;
      output.push(part.text);
    }
  }
  if (!request.bubble || item.type !== "message") return { text: output.join("") };
  // The same item with every text part whole, read as its bubble reads it.
  let next = 0;
  const whole = item.parts.map((part) =>
    part.type === "text" ? { ...part, text: output[next++] ?? part.text } : part,
  );
  return { text: bubbleWords({ ...item, parts: whole }) };
}
