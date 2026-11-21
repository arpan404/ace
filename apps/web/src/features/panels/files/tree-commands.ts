import { useClient, useThreadMeta } from "@ace/client-react";
import { cleanPath, folderKey, pathParts } from "@ace/ui-core";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { mentionInComposer } from "@/lib/composer-insert.ts";
import { useHostOpen, useRemoteHost } from "@/lib/host-open.ts";
import { keyboardEnv } from "@/lib/keybindings.ts";
import type { FileOperationDialog } from "./file-operation.ts";
import { treeClipboard, useTreeClip, type TreeClip } from "./tree-clipboard.ts";
import type { TreeEntry } from "./tree-entry.ts";
import { useFileMutations } from "./use-file-mutations.ts";

export type { TreeEntry } from "./tree-entry.ts";

/** How a file opens from the tree: a preview the next pick replaces, kept, or in its own tab. */
export type OpenHow = "preview" | "keep" | "side";

/** Everything the tree's menus and keys can do to its rows. */
export interface TreeCommands {
  threadId: string;
  online: boolean;
  /** The entries an action on `entry` covers: the selection when it holds `entry`, else it. */
  covered(entry: TreeEntry): TreeEntry[];
  open(path: string, how: OpenHow): void;
  operation(operation: FileOperationDialog): void;
  /** Showing a path in the file manager: only when this device is the daemon's machine. */
  reveal: { label: string; run(path: string): void } | undefined;
  duplicate(entry: TreeEntry): void;
  /** What Cut or Copy picked, until it is pasted (a cut) or replaced. */
  clip: TreeClip | undefined;
  cut(entries: readonly TreeEntry[]): void;
  copy(entries: readonly TreeEntry[]): void;
  /** Move the paths into `folder` ("" is the root), keeping their names. */
  move(paths: readonly string[], folder: string): void;
  /** Copy or move what was picked into `folder` ("" is the root). */
  paste(folder: string): void;
  copyPath(entries: readonly TreeEntry[], relative: boolean): void;
  mention(entries: readonly TreeEntry[]): void;
  findInFolder(folder: string): void;
  download(path: string): void;
  /** Fold every open folder under `folder` ("" folds them all). */
  collapseBelow(folder: string): void;
  /** Ask before moving the entries to Recently deleted. */
  remove(entries: readonly TreeEntry[]): void;
}

/** The file manager by name: the daemon's own word for it, else this platform's. */
function fileManagerName(named: string | undefined): string {
  if (named) return named;
  if (keyboardEnv().apple) return "Finder";
  return /Windows/i.test(globalThis.navigator?.userAgent ?? "") ? "File Explorer" : "Files";
}

export interface TreeCommandInputs {
  threadId: string;
  online: boolean;
  covered(entry: TreeEntry): TreeEntry[];
  open(path: string, how: OpenHow): void;
  operation(operation: FileOperationDialog): void;
  findInFolder(folder: string): void;
  download(path: string): void;
  opened: ReadonlySet<string>;
  onExpanded(folders: string[]): void;
  /** A copy landed here: the tree selects it. */
  onMade?(path: string): void;
}

/** The tree's commands for one thread's checkout, built on the existing file operations. */
export function useTreeCommands(inputs: TreeCommandInputs): TreeCommands {
  const { threadId } = inputs;
  const toast = useToast();
  const meta = useThreadMeta(threadId);
  const root = meta?.details?.worktree ?? meta?.details?.workspace?.path;
  const remote = useRemoteHost();
  const host = useHostOpen();
  const mutations = useFileMutations(threadId);
  const board = treeClipboard(useClient(), threadId);
  const clip = useTreeClip(board);
  const clipboard = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the path and copy it yourself." }),
  );
  const absolute = (path: string) => {
    if (!root) return path;
    const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    const base = root.replace(/[\\/]+$/, "");
    return path ? `${base}${separator}${path.split("/").join(separator)}` : base;
  };
  return {
    threadId,
    online: inputs.online,
    covered: inputs.covered,
    open: inputs.open,
    operation: inputs.operation,
    reveal: remote
      ? undefined
      : {
          label: `Reveal in ${fileManagerName(host.fileManager)}`,
          run: (path) => void host.reveal({ threadId, ...(path ? { path } : {}) }),
        },
    duplicate: (entry) => {
      void mutations
        .copy([entry], pathParts(entry.path).folder)
        .then((made) => made[0] && inputs.onMade?.(entry.folder ? folderKey(made[0]) : made[0]));
    },
    clip,
    move: (paths, folder) => void mutations.move(paths, folder),
    cut: (entries) => board.set({ mode: "cut", entries }),
    copy: (entries) => board.set({ mode: "copy", entries }),
    paste: (folder) => {
      if (!clip) return;
      if (clip.mode === "copy") {
        void mutations.copy(clip.entries, folder);
        return;
      }
      board.set(undefined);
      void mutations.move(
        clip.entries.map((entry) => entry.path),
        folder,
      );
    },
    copyPath: (entries, relative) =>
      clipboard.copy(
        entries.map((entry) => (relative ? entry.path : absolute(entry.path))).join("\n"),
      ),
    mention: (entries) => {
      mentionInComposer(
        threadId,
        entries.map((entry) => ({ path: entry.path })),
      );
    },
    findInFolder: inputs.findInFolder,
    download: inputs.download,
    collapseBelow: (folder) => {
      const prefix = folder ? folderKey(folder) : "";
      inputs.onExpanded(
        [...inputs.opened].filter((key) => !key.startsWith(prefix) || key === prefix),
      );
    },
    remove: (entries) => {
      const [first] = entries;
      if (!first) return;
      inputs.operation({
        kind: "delete",
        path: first.path,
        paths: entries.map((entry) => cleanPath(entry.path)),
      });
    },
  };
}
