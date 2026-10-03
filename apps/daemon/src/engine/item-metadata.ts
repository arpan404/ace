import type { Item } from "@ace/protocol";

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
