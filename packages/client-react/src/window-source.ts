import type { Selection, ThreadKey, ThreadReader, ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import { createContext, createElement, useContext, type ReactNode } from "react";

/*
 * A thread seen through a jumped window of its history (ADR 0062): the window's items stand in
 * for the leased live tail's, while agents, runs, interactions, tasks and the thread itself stay
 * live. A view inside `ThreadWindowProvider` reads the window through the same hooks it reads
 * the tail with, so one renderer serves both.
 */

const windowKey = (key: ThreadKey) =>
  key === "order" || key === "history" || key.startsWith("item:");

/** A window's items, oldest first and contiguous, and the cursor before its first item. */
export interface ThreadWindow {
  items: readonly Item[];
  before: number | null;
}

/**
 * The live source with its items replaced by the window's. A window never changes in place:
 * a slid window is a new source, so selections over items re-run when it is swapped in.
 */
export function windowSource(live: ThreadSource, window: ThreadWindow): ThreadSource {
  const items = new Map<string, Item>();
  for (const item of window.items) items.set(item.id, item);
  const order = window.items.map((item) => item.id);
  const source: ThreadSource = {
    get error() {
      return live.error;
    },
    get thread() {
      return live.thread;
    },
    get queue() {
      return live.queue;
    },
    get context() {
      return live.context;
    },
    get cursor() {
      return live.cursor;
    },
    order,
    itemsBefore: window.before,
    agentIds: () => live.agentIds(),
    children: (agentId) => live.children(agentId),
    interactionIds: () => live.interactionIds(),
    taskIds: () => live.taskIds(),
    item: (id) => items.get(id),
    agent: (id) => live.agent(id),
    run: (id) => live.run(id),
    interaction: (id) => live.interaction(id),
    task: (id) => live.task(id),
    usage: (id) => live.usage(id),
    contextMeter: (id) => live.contextMeter(id),
    usageSnapshot: (key) => live.usageSnapshot(key),
    // A window's items arrive whole from the daemon's bounded reply; nothing was cut here.
    truncated: () => false,
    select<T>(
      keys: readonly ThreadKey[],
      selector: (reader: ThreadReader) => T,
      equal?: (a: T, b: T) => boolean,
    ): Selection<T> {
      const liveKeys = keys.filter((key) => !windowKey(key));
      if (!liveKeys.length) {
        const value = selector(source);
        return { getSnapshot: () => value, subscribe: () => () => {} };
      }
      return live.select(liveKeys, () => selector(source), equal);
    },
  };
  return source;
}

const WindowContext = createContext<{ threadId: string; source: ThreadSource } | undefined>(
  undefined,
);

/**
 * Inside, hooks reading `threadId` (`useThread`, `useItem`, `useItemOrder`, ...) read `source`
 * instead of the live tail; with no source they read the tail as usual. The live lease is
 * held either way, so the subscription never drops while a window is shown.
 */
export function ThreadWindowProvider(props: {
  threadId: string;
  source: ThreadSource | undefined;
  children?: ReactNode;
}) {
  const value = props.source ? { threadId: props.threadId, source: props.source } : undefined;
  return createElement(WindowContext.Provider, { value }, props.children);
}

export function useThreadWindow(threadId: string | undefined): ThreadSource | undefined {
  const window = useContext(WindowContext);
  return window && window.threadId === threadId ? window.source : undefined;
}
