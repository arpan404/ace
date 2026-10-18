import { useThreadMeta } from "@ace/client-react";
import { useEffect, useRef } from "react";
import type { ScopeWorkspace, WorkspaceStore } from "@/lib/workspace/index.ts";
import { useLocal } from "../store.ts";
import type { BrowserView } from "../sources.ts";
import { agentTab, follow, stopWatching, watching } from "./watch-mode.ts";

/**
 * The agents stopped working: the run ended, failed, or waits on the person or on something
 * outside it. Watching the page has nothing more to show until they work again.
 */
const finished = (state: string | undefined) => state !== undefined && state !== "working";

/**
 * Keeps a thread's watch mode going while the thread shows: follows the agent from tab to tab,
 * puts the panel back once the agents stop working, and ends quietly when the person closes
 * the panel themselves.
 */
export function useWatchMode(
  store: WorkspaceStore,
  threadId: string,
  view: BrowserView | undefined,
  workspace: ScopeWorkspace,
): boolean {
  const active = useLocal(watching, (all) => all.has(threadId));
  const state = useThreadMeta(threadId)?.status?.state;
  const previous = useRef(state);
  const target = agentTab(view);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (active && finished(state) && !finished(was)) stopWatching(store, threadId, true);
  }, [active, state, store, threadId]);
  useEffect(() => {
    if (active && target) follow(store, threadId, target);
  }, [active, target, store, threadId]);
  useEffect(() => {
    if (active && !workspace.open) stopWatching(store, threadId, false);
  }, [active, workspace.open, store, threadId]);
  return active;
}
