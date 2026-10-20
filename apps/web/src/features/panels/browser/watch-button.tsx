import { EyeIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useWorkspaceStore } from "@/lib/workspace/index.ts";
import { useLocal } from "../store.ts";
import type { BrowserView } from "../sources.ts";
import { roundButton } from "./page-toolbar.tsx";
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

/** The toolbar's eye: shows the agent's tab large beside the chat while it works. */
export function WatchButton(props: { watching: boolean | undefined; toggle(): void }) {
  return (
    <IconButton
      icon={EyeIcon}
      label={props.watching ? "Stop watching the agent" : "Watch the agent"}
      pressed={props.watching === true}
      className={roundButton}
      onClick={props.toggle}
    />
  );
}
