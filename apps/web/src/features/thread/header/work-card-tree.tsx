import { useClient, useConnectionState, useThreadError } from "@ace/client-react";
import { useThreadField } from "@ace/client-react/thread-field";
import { useLayoutEffect, useRef, useState } from "react";
import { useLayoutServices, type SessionKey } from "@/lib/layout.tsx";
import { createWorkCardStore, type WorkCardStore } from "./work-card-store.ts";
import { createWorkCardTrees, type WorkCardTrees } from "./work-card-trees.ts";

/*
 * Which thread tree a screen's Work card follows: the daemon names the tree's root (`treeRootId`)
 * on every thread record, so the client keys the card directly on `treeRootId ?? threadId` with no
 * parent walk and no extra thread subscriptions.
 */

const treesKey: SessionKey<WorkCardTrees> = { name: "workCardTrees" };
const sideKey: SessionKey<{ current: boolean }> = { name: "workCardSide" };

/** This app's per-tree card memory, shared by every screen (`work-card-trees`). */
export function useWorkCardTrees(): WorkCardTrees {
  const { storage, sessionValue } = useLayoutServices();
  return sessionValue(treesKey, () => createWorkCardTrees(storage));
}

/**
 * Whether the thread area had room to dock the Work card on its last measurement in this layout
 * session, so navigating within an open tree starts docked on the first render.
 */
export function useWorkCardSide(): { current: boolean } {
  const { sessionValue } = useLayoutServices();
  return sessionValue(sideKey, () => ({ current: false }));
}

interface RootFields {
  id: string;
  treeRootId?: string | undefined;
  delegatedFrom?: { threadId: string; rootThreadId?: string | undefined } | undefined;
}

/** The tree's main thread id as named by the daemon, falling back to delegatedFrom for older daemons. */
const treeRootOf = (thread: RootFields): string =>
  thread.treeRootId ??
  thread.delegatedFrom?.rootThreadId ??
  thread.delegatedFrom?.threadId ??
  thread.id;

/**
 * The screen's Work card store, keyed on the tree's root (`treeRootId ?? threadId`). Starts from
 * the tree's remembered choice on the first render whenever the thread is already cached or listed
 * in the sidebar, so navigating to another screen of an open tree never paints closed first.
 */
export function useWorkCard(threadId: string): WorkCardStore {
  const trees = useWorkCardTrees();
  const lastSide = useWorkCardSide();
  const client = useClient();
  const threadRoot = useThreadField(threadId, treeRootOf);
  const cached = client.cachedThreads?.()?.thread(threadId);
  const root = threadRoot ?? (cached ? treeRootOf(cached) : undefined);
  const failed = useThreadError(threadId) !== undefined;
  // Lost, not merely still connecting: a first connect is not a reason to fall back.
  const state = useConnectionState();
  const down = state === "reconnecting" || state === "offline" || state === "fatal";
  const fallback = root === undefined && (failed || down);
  const treeId = root ?? (fallback ? threadId : undefined);
  const [store] = useState(() =>
    createWorkCardStore(treeId !== undefined ? trees.memory(treeId) : undefined, lastSide.current),
  );
  /** The fallback tree followed while the thread couldn't be read, and its choice then. */
  const fellBack = useRef<{ id: string; open: boolean }>(undefined);
  useLayoutEffect(() => {
    if (treeId === undefined) return;
    const memory = trees.memory(treeId);
    const held = fellBack.current;
    if (fallback) fellBack.current = { id: treeId, open: memory.open() };
    else {
      fellBack.current = undefined;
      // A choice made on the fallback tree carries over to the real tree once readable.
      const open = held && held.id !== treeId ? trees.memory(held.id).open() : undefined;
      if (held && open !== undefined && open !== held.open) memory.remember(open);
    }
    return store.follow(memory);
  }, [store, trees, treeId, fallback]);
  return store;
}
