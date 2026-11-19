import { useSyncExternalStore } from "react";
import type { TreeEntry } from "./tree-commands.ts";

/** Entries cut or copied in the tree, waiting for a paste. */
export interface TreeClip {
  mode: "cut" | "copy";
  entries: readonly TreeEntry[];
}

/**
 * The tree's own clipboard for one thread: what Cut or Copy picked, kept apart from the system
 * clipboard (checkout files aren't on this device), shared by every Files tab of the thread so
 * a copy in one tab pastes in another.
 */
export class TreeClipboard {
  #clip: TreeClip | undefined;
  readonly #listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get clip(): TreeClip | undefined {
    return this.#clip;
  }
  set(clip: TreeClip | undefined): void {
    this.#clip = clip;
    for (const listener of this.#listeners) listener();
  }
}

const boards = new WeakMap<object, Map<string, TreeClipboard>>();

/** The thread's tree clipboard for this client, made on first use. */
export function treeClipboard(owner: object, threadId: string): TreeClipboard {
  let byThread = boards.get(owner);
  if (!byThread) {
    byThread = new Map();
    boards.set(owner, byThread);
  }
  let board = byThread.get(threadId);
  if (!board) {
    board = new TreeClipboard();
    byThread.set(threadId, board);
  }
  return board;
}

export function useTreeClip(board: TreeClipboard): TreeClip | undefined {
  return useSyncExternalStore(board.subscribe, () => board.clip);
}
