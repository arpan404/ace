import type { ThreadKey, ThreadReader } from "@ace/client";
import { newestAgentPage } from "@ace/ui-core";
import { useEffect, useRef } from "react";
import { useWatched, type Watched } from "@/lib/use-watched.ts";
import { useRevealAgentPages, useShowBrowserPanel } from "@/features/panels/index.ts";

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
 * When an agent opens or moves a page in the thread's browser and this device asked for it
 * ("Open the browser panel when an agent opens a page", off by default), the side panel shows
 * it: the panel tab of the browser tab the daemon shows comes forward (opening the panel), so
 * the person sees what they would see in the browser, never a tab the daemon kept out of their
 * view (ADR 0067's 30-second rule). Pages opened before this view mounted (history), or while
 * the setting was off, never pull the panel open.
 */
export function AgentPageReveal(props: { threadId: string }) {
  const { threadId } = props;
  const page = useWatched(threadId, orderKeys, readAgentPage, Object.is);
  const [reveal] = useRevealAgentPages();
  const show = useShowBrowserPanel(threadId);
  const shown = useRef<string | undefined | null>(null);
  useEffect(() => {
    // The first reading is history: remember it, show nothing.
    if (shown.current === null) {
      shown.current = page;
      return;
    }
    if (!page || page === shown.current) return;
    shown.current = page;
    if (reveal) show();
  }, [page, reveal, show]);
  return null;
}
