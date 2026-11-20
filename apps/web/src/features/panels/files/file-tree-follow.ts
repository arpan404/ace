import {
  folderKey,
  readJson,
  revealingFolders,
  writeJson,
  type FolderRow,
  type KeyValueStorage,
} from "@ace/ui-core";
import * as z from "zod/mini";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { onRevealInExplorer } from "./file-tree-deck.ts";

/*
 * The explorer following the focused editor (workbench spec 33): the open file's folders open
 * and its row is selected and scrolled into view, without taking focus. The person can turn the
 * following off on this device; an explicit reveal (`revealInExplorer`) works either way.
 */

const followKey = "ace.files.follow";
const Follow = z.catch(z.boolean(), true);

class FollowMemory {
  readonly #storage: KeyValueStorage | undefined;
  readonly #listeners = new Set<() => void>();
  value: boolean;
  constructor(storage: KeyValueStorage | undefined) {
    this.#storage = storage;
    this.value = readJson(storage, followKey, Follow, true);
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  set(value: boolean) {
    this.value = value;
    writeJson(this.#storage, followKey, value);
    for (const listener of this.#listeners) listener();
  }
}

const memories = new WeakMap<object, FollowMemory>();
const withoutStorage = new FollowMemory(undefined);

/** Whether the explorer follows the open file on this device, and the switch. */
export function useExplorerFollows(): [boolean, (follows: boolean) => void] {
  const { storage } = useLayout();
  let memory = storage ? memories.get(storage) : withoutStorage;
  if (!memory && storage) {
    memory = new FollowMemory(storage);
    memories.set(storage, memory);
  }
  const held = memory ?? withoutStorage;
  const read = useCallback(() => held.value, [held]);
  const value = useSyncExternalStore(held.subscribe, read, read);
  return [value, useCallback((next: boolean) => held.set(next), [held])];
}

/** A path to reveal; `folder` when it names a folder (its row key ends in "/"). */
export interface RevealTarget {
  path: string;
  folder: boolean;
  /** Put the keyboard on the row too (after a rename the tree started). */
  focus?: boolean | undefined;
}

/**
 * Reveal rows in the tree: the current file each time it changes (while the explorer follows),
 * whatever `revealInExplorer` names, and whatever the tree itself asks for (`reveal`, after a
 * rename). Opens the missing folders, then once the row is listed scrolls it into view and
 * hands it to `onRevealed` to select. Each request is its own object, so asking for the same
 * path again reveals it again.
 */
export function useRevealRows(options: {
  threadId: string;
  current: string | undefined;
  follows: boolean;
  opened: ReadonlySet<string>;
  onExpanded(folders: string[]): void;
  rows: readonly FolderRow[];
  list: RefObject<HTMLElement | null>;
  handle: RefObject<VirtualRowsHandle | null>;
  onRevealed(key: string, focus: boolean): void;
}): (target: RevealTarget) => void {
  const { threadId, current, follows, opened, onExpanded, rows } = options;
  const [target, setTarget] = useState<RevealTarget | undefined>(() =>
    follows && current ? { path: current, folder: false } : undefined,
  );
  // The current file changing is a request of its own, taken while rendering.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    if (follows && current) setTarget({ path: current, folder: false });
  }
  const reveal = useCallback((next: RevealTarget) => setTarget({ ...next }), []);
  useEffect(
    () => onRevealInExplorer(threadId, (path) => reveal({ path, folder: false })),
    [threadId, reveal],
  );
  // Each request opens its folders once; folding one by hand afterwards stays folded.
  const expandedFor = useRef<RevealTarget>(undefined);
  useEffect(() => {
    if (!target || expandedFor.current === target) return;
    expandedFor.current = target;
    const missing = revealingFolders(opened, target.path);
    if (missing.length) onExpanded([...opened, ...missing]);
  }, [target, opened, onExpanded]);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const done = useRef<RevealTarget>(undefined);
  useEffect(() => {
    if (!target || done.current === target) return;
    const key = target.folder ? folderKey(target.path) : target.path;
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    done.current = target;
    const { list, handle, onRevealed } = latest.current;
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
    if (row) row.scrollIntoView?.({ block: "nearest" });
    else handle.current?.scrollToIndex(index, "auto");
    onRevealed(key, target.focus === true);
  }, [target, rows]);
  return reveal;
}
