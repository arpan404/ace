import type { Item } from "@ace/protocol";

/**
 * The interaction a `permission-review:*` notice is about, if the item is one. The review
 * itself is read from that interaction (`interaction.review`), which the client parsed when the
 * daemon's `permission.reviewed` event arrived; the notice's raw copy is only its pointer.
 */
export function reviewedInteraction(item: Item | undefined): string | undefined {
  if (item?.type !== "notice") return undefined;
  for (const raw of item.raw) {
    if (raw.type !== "permission.reviewed" || !("data" in raw)) continue;
    const data: unknown = raw.data;
    if (typeof data === "object" && data !== null && "interactionId" in data) {
      const id = data.interactionId;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}
