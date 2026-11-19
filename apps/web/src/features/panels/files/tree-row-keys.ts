import { ancestorFolders, cleanPath, folderKey, pathParts, type FolderRow } from "@ace/ui-core";
import type { KeyboardEvent } from "react";
import { openContextMenuFromKeyboard } from "@/components/ui/context-menu.tsx";
import type { OpenHow, TreeCommands, TreeEntry } from "./tree-commands.ts";
import { treeAction, type TreeAction } from "./tree-keys.ts";
import type { TreeSelection } from "./use-tree-selection.ts";

/** What a key press on a tree row can reach. */
export interface RowKeyContext {
  rows: readonly FolderRow[];
  commands: TreeCommands;
  selection: TreeSelection;
  focusRow(key: string | undefined): void;
  /** Up from the first row goes back to the filter field. */
  focusFilter(): void;
  toggle(folder: string, expand?: boolean): void;
  activate(row: FolderRow, how: OpenHow): void;
}

const listed = (row: FolderRow | undefined) =>
  row !== undefined && row.kind !== "loading" && row.kind !== "error";

/** A row as its actions see it. */
export function entryOf(row: FolderRow): TreeEntry {
  return { path: cleanPath(row.key), folder: row.kind === "folder" };
}

/** Where pasting or creating "here" goes for a row: the folder itself, else the file's folder. */
export function folderOf(row: FolderRow): string {
  return row.kind === "folder" ? cleanPath(row.key) : pathParts(row.key).folder;
}

function runAction(ctx: RowKeyContext, action: TreeAction, row: FolderRow): boolean {
  const { commands } = ctx;
  const entry = entryOf(row);
  const covered = commands.covered(entry);
  const edits = commands.online;
  switch (action) {
    case "openTab":
      if (row.kind !== "file") return false;
      commands.open(entry.path, "tab");
      return true;
    case "rename":
    case "move":
      if (edits) commands.operation({ kind: action, path: row.key });
      return true;
    case "delete":
      if (edits) commands.remove(covered);
      return true;
    case "copyPath":
    case "copyRelativePath":
      commands.copyPath(covered, action === "copyRelativePath");
      return true;
    case "findInFolder":
      commands.findInFolder(folderOf(row));
      return true;
    case "cut":
    case "copy":
      commands[action](covered);
      return true;
    case "paste":
      if (edits) commands.paste(folderOf(row));
      return true;
    case "selectAll":
      ctx.selection.all();
      return true;
    case "reveal":
      commands.reveal?.run(entry.path);
      return true;
    default:
      return false;
  }
}

/** A key press on a tree row: move focus, fold, open, or one of the row's actions. */
export function onRowKey(
  ctx: RowKeyContext,
  event: KeyboardEvent<HTMLElement>,
  row: FolderRow,
  index: number,
): void {
  if (!listed(row)) return;
  const { rows } = ctx;
  if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
    if (row.kind === "more") return;
    event.preventDefault();
    openContextMenuFromKeyboard(event.currentTarget);
    return;
  }
  const action = row.kind === "more" ? undefined : treeAction(event.nativeEvent);
  if (action && action !== "open" && runAction(ctx, action, row)) {
    event.preventDefault();
    return;
  }
  const step = (delta: number) => {
    for (let at = index + delta; at >= 0 && at < rows.length; at += delta)
      if (listed(rows[at])) return rows[at];
    return undefined;
  };
  if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    // Shift+arrows grow or shrink the selection from its anchor as focus moves.
    const next = step(event.key === "ArrowDown" ? 1 : -1);
    event.preventDefault();
    if (!next || next.kind === "more") return;
    ctx.focusRow(next.key);
    ctx.selection.extend(next.key);
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      ctx.focusRow(step(1)?.key);
      break;
    case "ArrowUp":
      if (index === 0) ctx.focusFilter();
      else ctx.focusRow(step(-1)?.key);
      break;
    case "Home":
      ctx.focusRow(rows.find(listed)?.key);
      break;
    case "End":
      ctx.focusRow(rows.findLast(listed)?.key);
      break;
    case "ArrowRight":
      if (row.kind !== "folder") return;
      if (!row.expanded) ctx.toggle(row.key, true);
      else ctx.focusRow(step(1)?.key);
      break;
    case "ArrowLeft":
      if (row.kind === "more") {
        ctx.focusRow(row.folder ? folderKey(row.folder) : undefined);
        break;
      }
      if (row.kind === "folder" && row.expanded) ctx.toggle(row.key, false);
      else ctx.focusRow(ancestorFolders(row.key).at(-1));
      break;
    case "Enter":
      ctx.activate(row, "keep");
      break;
    case " ":
      ctx.activate(row, "preview");
      break;
    default:
      return;
  }
  event.preventDefault();
}
