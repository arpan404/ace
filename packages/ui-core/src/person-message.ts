import type { Item } from "@ace/protocol";

const continueKinds = new Set(["restart", "limit_resume"]);

/**
 * ace's Continue after a restart or a usage limit, sent in the person's words ("Continue where
 * you left off."): it reads and counts as their message, starting a turn. The long instructions
 * older builds sent stay ace's own rows.
 */
export function isContinueInput(item: Item | undefined): boolean {
  if (item?.type !== "message" || item.role !== "user" || !item.synthetic) return false;
  if (!continueKinds.has(item.origin?.kind ?? "")) return false;
  const text = item.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  return text.length > 0 && text.length <= 200 && !text.includes("\n");
}

/** The person's own message: typed by them, or their Continue that ace sent for them. */
export function isPersonMessage(item: Item | undefined): boolean {
  return (
    item?.type === "message" && item.role === "user" && (!item.synthetic || isContinueInput(item))
  );
}
