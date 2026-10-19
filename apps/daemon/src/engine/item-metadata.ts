import type { Item } from "@ace/protocol";

/** Only text items have metadata smaller than the item; any other item is its own metadata. */
export function keepsItemMetadata(item: Item): boolean {
  return item.type === "message" || item.type === "reasoning" || item.type === "notice";
}
/** Text is already persisted as a base plus chunks. Core needs its shape, not prior
 * characters, to validate/accept the next append. Full reads still use the base. */
export function itemMetadata(item: Item): Item {
  if (item.type === "message")
    return {
      ...item,
      parts: item.parts.map((part) => (part.type === "text" ? { ...part, text: "" } : part)),
    };
  if (item.type === "reasoning" || item.type === "notice") return { ...item, text: "" };
  return item;
}
