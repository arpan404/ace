import { cleanPath, folderKey, pathParts, type FolderRow } from "@ace/ui-core";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { z } from "zod";
import type { TreeEntry } from "./tree-commands.ts";
import { entryOf } from "./tree-row-keys.ts";

/** Tree rows being dragged, as the drag carries them. */
const treeDragType = "application/x-ace-tree-entries";
/** How long a drag rests on a closed folder before it opens. */
const openDelay = 600;

const DraggedEntries = z.array(z.object({ path: z.string(), folder: z.boolean() }));

/** The rows a drop carries, read leniently: another window's drag may carry anything. */
function draggedEntries(event: DragEvent<HTMLElement>): TreeEntry[] {
  try {
    const parsed = DraggedEntries.safeParse(JSON.parse(event.dataTransfer.getData(treeDragType)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const fromTree = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(treeDragType);
const fromOutside = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");

/** The folder a drop on `row` goes into: a folder row itself, else the file's folder. */
const dropFolder = (row: FolderRow) =>
  row.kind === "folder" ? row.key : folderKey(pathParts(row.key).folder);

/**
 * Dragging in the file tree: rows (a selection drags whole) move into the folder they're
 * dropped on, a closed folder opens while a drag rests on it, and files from outside upload
 * there. A drop on a file goes into the file's folder; on the tree's empty space, the root
 * for rows and the showing file's folder for files from outside.
 */
export function useTreeDrag(options: {
  covered(entry: TreeEntry): TreeEntry[];
  onMove(paths: readonly string[], folder: string): void;
  onUpload(files: readonly File[], folder: string): void;
  expand(folder: string): void;
  /** Where files from outside go when dropped on the empty space. */
  uploadFolder: string;
}) {
  const [dropTarget, setDropTarget] = useState<string>();
  const opening = useRef<{ folder: string; timer: ReturnType<typeof setTimeout> }>(undefined);
  const stopOpening = () => {
    clearTimeout(opening.current?.timer);
    opening.current = undefined;
  };
  // A folder waiting to open under a drag never opens once the tree is gone.
  useEffect(() => () => clearTimeout(opening.current?.timer), []);
  const end = () => {
    stopOpening();
    setDropTarget(undefined);
  };
  /** Accept the drag over `folder` (a folder key, "" the root), or say it can't land here. */
  const over = (event: DragEvent<HTMLElement>, folder: string) => {
    const inside = fromTree(event);
    if (!inside && !fromOutside(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = inside ? "move" : "copy";
    setDropTarget(folder);
    return true;
  };
  const land = (event: DragEvent<HTMLElement>, folder: string) => {
    if (!fromTree(event) && !fromOutside(event)) return;
    event.preventDefault();
    event.stopPropagation();
    end();
    if (fromTree(event)) {
      const entries = draggedEntries(event);
      if (entries.length)
        options.onMove(
          entries.map((entry) => entry.path),
          cleanPath(folder),
        );
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) options.onUpload(files, folder);
  };
  return {
    dropTarget,
    /** A row's drag handlers: it drags itself (or its selection) and takes drops. */
    row: (row: FolderRow) => ({
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        const entries = options.covered(entryOf(row));
        event.dataTransfer.setData(treeDragType, JSON.stringify(entries));
        event.dataTransfer.setData("text/plain", entries.map((entry) => entry.path).join("\n"));
        event.dataTransfer.effectAllowed = "copyMove";
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!over(event, dropFolder(row))) return;
        if (row.kind !== "folder" || row.expanded || opening.current?.folder === row.key) return;
        stopOpening();
        opening.current = {
          folder: row.key,
          timer: setTimeout(() => options.expand(row.key), openDelay),
        };
      },
      onDragLeave: stopOpening,
      onDrop: (event: DragEvent<HTMLElement>) => land(event, dropFolder(row)),
      onDragEnd: end,
    }),
    /** The tree's own area: what lands outside any row. */
    area: {
      onDragOver: (event: DragEvent<HTMLElement>) =>
        void over(event, fromTree(event) ? "" : options.uploadFolder),
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) end();
      },
      onDrop: (event: DragEvent<HTMLElement>) =>
        land(event, fromTree(event) ? "" : options.uploadFolder),
    },
  };
}

export type TreeDrag = ReturnType<typeof useTreeDrag>;
