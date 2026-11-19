import { useWorkspaceStore } from "@/lib/workspace/index.ts";
import { useLocal } from "../store.ts";
import type { BrowserView } from "../sources.ts";
import { agentTab, startWatching, stopWatching, watching } from "./watch-mode.ts";

/**
 * Watch mode for one thread's browser: `watching` is undefined while no agent browses (and
 * watch mode is off), so there is nothing to offer.
 */
export function useWatchToggle(threadId: string, live: BrowserView | undefined) {
  const store = useWorkspaceStore();
  const on = useLocal(watching, (all) => all.has(threadId));
  const target = agentTab(live);
  return {
    watching: on ? true : target ? false : undefined,
    toggle: () => {
      if (on) stopWatching(store, threadId, true);
      else if (target) startWatching(store, threadId, target);
    },
  };
}
