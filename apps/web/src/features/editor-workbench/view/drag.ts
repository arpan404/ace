/*
 * Tab drags carry their own type, so the side panel's strip (which takes `tabDragType`) ignores
 * them, plus the path as plain text for anything else that accepts a file path. When W5 joins
 * the explorer's file drags to the Deck (spec 16), file drops read the same path type.
 */

export const deckTabDragType = "application/x-ace-deck-tab";

export interface TabDrag {
  group: string;
  path: string;
}

export function writeTabDrag(transfer: DataTransfer, drag: TabDrag): void {
  transfer.setData(deckTabDragType, JSON.stringify(drag));
  transfer.setData("text/plain", drag.path);
  transfer.effectAllowed = "copyMove";
}

export function carriesTab(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(deckTabDragType);
}

/** The dragged tab, or nothing when the data isn't a tab drag (another app's, or corrupt). */
export function readTabDrag(transfer: DataTransfer): TabDrag | undefined {
  try {
    const value: unknown = JSON.parse(transfer.getData(deckTabDragType));
    if (typeof value !== "object" || value === null) return undefined;
    const group: unknown = Reflect.get(value, "group");
    const path: unknown = Reflect.get(value, "path");
    return typeof group === "string" && typeof path === "string" ? { group, path } : undefined;
  } catch {
    return undefined;
  }
}

/** ⌥-drag opens a second view and leaves the original (spec 16). */
export function copiesOnDrop(event: { altKey: boolean }): boolean {
  return event.altKey;
}
