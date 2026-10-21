import type { ClientCore } from "@ace/client";
import type { ItemId, ThreadId } from "@ace/protocol";

/** History is a separate SDK window. Resolve its authenticated item without replacing the tail. */
export async function readNativeItem(
  owner: ClientCore,
  threadId: ThreadId,
  itemId: ItemId,
  signal: AbortSignal,
) {
  const cached = owner.cachedThread(threadId)?.item(itemId);
  if (cached) return cached;
  const window = await owner.itemsWindow({ threadId, itemId, before: 0, after: 0 }, { signal });
  return window.items.find((item) => item.id === itemId);
}
