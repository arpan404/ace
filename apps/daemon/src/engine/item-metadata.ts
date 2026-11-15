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
/**
 * A copy of text metadata that one text append may change without touching the original: an
 * append writes only the item's own text and source, or the last part's, or pushes a part.
 */
export function appendTarget(metadata: Item): Item {
  if (metadata.type === "message")
    return {
      ...metadata,
      parts: metadata.parts.map((part) => (part.type === "text" ? { ...part } : part)),
    };
  if (metadata.type === "reasoning" || metadata.type === "notice") return { ...metadata };
  return structuredClone(metadata);
}
/**
 * Whether a text append left `item`'s metadata equal to `previous`, the metadata it was
 * folded from: it grew only text, which metadata blanks. False whenever it may have changed a
 * source's byte count or added a part, so the caller compares in full.
 */
export function unchangedByTextAppend(previous: Item, item: Item): boolean {
  if (item.type === "message" && previous.type === "message") {
    const last = item.parts.at(-1);
    return item.parts.length === previous.parts.length && last?.type === "text" && !last.source;
  }
  return (
    (item.type === "reasoning" || item.type === "notice") &&
    item.type === previous.type &&
    !item.source
  );
}
