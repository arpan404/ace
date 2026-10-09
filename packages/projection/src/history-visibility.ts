import type { Item } from "@ace/protocol";

/** Bookkeeping stays available as raw history, without taking a transcript row. */
export function isRawHistoryItem(item: Item | undefined): boolean {
  if (item?.type !== "notice") return false;
  return (
    item.code === "history.raw-only" ||
    /^Native history record: (?:event_msg|turn_context|session_meta)$/.test(item.text) ||
    item.text === "Native reasoning record"
  );
}
