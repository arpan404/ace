/*
 * Tab drags carry their own type, so the side panel's strip (which takes `tabDragType`) ignores
 * them, plus the path as plain text for anything else that accepts a file path. Files dragged
 * from the explorer carry the tree's rows (`application/x-ace-tree-entries`, written by
 * `panels/files/use-tree-drag.ts`): dropped on a group, the files among them open there (spec 16).
 */

export const editorTabDragType = "application/x-ace-editor-tab";

export interface TabDrag {
  group: string;
  path: string;
}

export function writeTabDrag(transfer: DataTransfer, drag: TabDrag): void {
  transfer.setData(editorTabDragType, JSON.stringify(drag));
  transfer.setData("text/plain", drag.path);
  transfer.effectAllowed = "copyMove";
}

export function carriesTab(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(editorTabDragType);
}

/** The dragged tab, or nothing when the data isn't a tab drag (another app's, or corrupt). */
export function readTabDrag(transfer: DataTransfer): TabDrag | undefined {
  try {
    const value: unknown = JSON.parse(transfer.getData(editorTabDragType));
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

/** The explorer's drag type: rows of one thread's tree, as `use-tree-drag.ts` writes them. */
export const treeEntriesDragType = "application/x-ace-tree-entries";

/** A drag a group takes: one of its tabs, or files from the explorer. */
export type GroupDrag = { kind: "tab"; tab: TabDrag } | { kind: "files"; paths: string[] };

/** Over a group only the drag's types can be read: a tab or the explorer's rows. */
export function carriesGroupDrag(transfer: DataTransfer): boolean {
  const types = new Set(transfer.types);
  return types.has(editorTabDragType) || types.has(treeEntriesDragType);
}

/**
 * The files dragged from `threadId`'s explorer (folders left out). Rows from another thread's
 * tree name another checkout's files, so they open nothing here.
 */
export function readFileDrag(transfer: DataTransfer, threadId: string | undefined): string[] {
  if (threadId === undefined) return [];
  try {
    const value: unknown = JSON.parse(transfer.getData(treeEntriesDragType));
    if (typeof value !== "object" || value === null) return [];
    if (Reflect.get(value, "threadId") !== threadId) return [];
    const entries: unknown = Reflect.get(value, "entries");
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return [];
      const path: unknown = Reflect.get(entry, "path");
      return typeof path === "string" && Reflect.get(entry, "folder") !== true ? [path] : [];
    });
  } catch {
    return [];
  }
}

/** What a drop on a group carries: a tab first, else this thread's files. */
export function readGroupDrag(
  transfer: DataTransfer,
  threadId: string | undefined,
): GroupDrag | undefined {
  const tab = readTabDrag(transfer);
  if (tab) return { kind: "tab", tab };
  const paths = readFileDrag(transfer, threadId);
  return paths.length > 0 ? { kind: "files", paths } : undefined;
}
