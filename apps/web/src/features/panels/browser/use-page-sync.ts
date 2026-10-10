import { useEffect } from "react";
import { useWorkspaceActions, useWorkspaceStore } from "@/lib/workspace/index.ts";
import type { BrowserView } from "../sources.ts";
import { browserTabData } from "./browser-state.ts";

export const pageTabId = (page: string) => `p-${page}`;

export function usePageSync(threadId: string, live: BrowserView | undefined) {
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(threadId);
  const page = live?.closed ? undefined : live?.activeTabId;
  const url = live?.url;
  useEffect(() => {
    if (!page) return;
    const tabs = store.get(threadId).tabs.filter((tab) => tab.kind === "browser");
    const tab = tabs[0];
    if (tab) actions.update(tab.key, { data: { ...browserTabData(tab), page, url } });
    else
      actions.open(
        { kind: "browser", id: pageTabId(page), data: { page, url } },
        { reveal: false },
      );
    for (const duplicate of tabs.slice(1)) void actions.close(duplicate.key);
  }, [page, url, threadId, store, actions]);
}
