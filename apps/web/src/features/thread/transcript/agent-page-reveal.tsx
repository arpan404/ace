import type { ThreadKey, ThreadReader } from "@ace/client";
import { newestAgentPage } from "@ace/ui-core";
import { useEffect, useRef } from "react";
import { useWatched, type Watched } from "@/lib/use-watched.ts";
import { useWorkspaceActions, useWorkspaceStore } from "@/lib/workspace/index.ts";

const orderKeys: readonly ThreadKey[] = ["order"];

/** The newest page an agent opened in this thread's browser, among its latest items. */
function readAgentPage(reader: ThreadReader): Watched<string | undefined> {
  const tail = reader.order.slice(-8);
  return {
    value: newestAgentPage(tail, (id) => reader.item(id)),
    watch: tail.map((id) => `item:${id}`),
  };
}

/**
 * When an agent opens or moves a page in the thread's browser, the side panel shows it: the
 * thread's Browser tab comes forward (opening the panel), so the person sees what the agent
 * sees. Pages opened before this view mounted (history) never pull the panel open.
 */
export function AgentPageReveal(props: { threadId: string }) {
  const { threadId } = props;
  const page = useWatched(threadId, orderKeys, readAgentPage, Object.is);
  const actions = useWorkspaceActions(threadId);
  const store = useWorkspaceStore();
  const shown = useRef<string | undefined | null>(null);
  useEffect(() => {
    // The first reading is history: remember it, show nothing.
    if (shown.current === null) {
      shown.current = page;
      return;
    }
    if (!page || page === shown.current) return;
    shown.current = page;
    const tab = store.get(threadId).tabs.find((each) => each.kind === "browser");
    if (tab) {
      actions.activate(tab.key);
      actions.setOpen(true);
    } else actions.open({ kind: "browser" });
  }, [page, threadId, store, actions]);
  return null;
}
