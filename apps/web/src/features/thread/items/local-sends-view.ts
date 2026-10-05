import type { PendingSend } from "@ace/client";
import { useSyncExternalStore } from "react";
import type { StagedSend } from "../composer/send-store.ts";
import type { Block } from "../transcript/blocks.ts";

/*
 * The person's messages on their way, as the transcript reads them (UX audit SY-2, SY-3): how to
 * merge them into the blocks and what each bubble has to say. The logic loads with the thread's
 * deferred parts (`LocalSends` publishes a view here per thread), so the route's first paint
 * carries only this slot; until it arrives the transcript shows the daemon's items as they are.
 */

/** What a bubble knows of its message's way to the daemon. */
export interface LocalSend {
  send?: PendingSend | undefined;
  staged?: StagedSend | undefined;
  /** The daemon's notice that the message wasn't delivered. */
  noticeId?: string | undefined;
}

export interface LocalSendsView {
  /** The blocks with this window's messages on their way merged in. */
  merge(blocks: readonly Block[]): readonly Block[];
  /** What the bubble under `itemId` has to say. */
  find(itemId: string): LocalSend;
}

let views: ReadonlyMap<string, LocalSendsView> = new Map();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => views;

export function publishLocalSends(threadId: string, view: LocalSendsView | undefined): void {
  const next = new Map(views);
  if (view) next.set(threadId, view);
  else next.delete(threadId);
  views = next;
  for (const listener of listeners) listener();
}

export function useLocalSendsView(threadId: string): LocalSendsView | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot).get(threadId);
}
