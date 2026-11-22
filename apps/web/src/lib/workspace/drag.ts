/** Dragged tabs carry their key under this type, so a drop target can tell a tab drag from a file. */
export const tabDragType = "application/x-ace-workspace-tab";

/**
 * Rows dragged from a thread's Files explorer carry `{ threadId, entries: [{ path, folder }] }`
 * as JSON under this type: the tree moves them, and an editor group opens the files among them.
 */
export const treeEntriesDragType = "application/x-ace-tree-entries";
