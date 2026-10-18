import { useQuery } from "@tanstack/react-query";
import { useLoadedServices } from "../services.ts";

/** A tab the composer's `@` list offers: enough to name it and point the agent at it. */
export interface MentionTab {
  tabId: string;
  url: string;
  title: string;
  favicon?: string | undefined;
}

/**
 * The thread's open browser tabs while the composer's `@` list is open, read once each time it
 * opens. Tabs the person keeps agents out of, and blank ones, are never offered.
 */
export function useMentionTabs(threadId: string | undefined, open: boolean): readonly MentionTab[] {
  const preview = useLoadedServices()?.preview;
  const listed = useQuery({
    queryKey: ["thread", "browser-tabs", threadId],
    queryFn: async () => (threadId && preview?.listTabs ? preview.listTabs(threadId) : []),
    enabled: open && !!threadId && !!preview,
    staleTime: 2_000,
  });
  return (listed.data ?? []).flatMap((tab) =>
    tab.private || !tab.url || tab.url === "about:blank"
      ? []
      : [{ tabId: tab.tabId, url: tab.url, title: tab.title, favicon: tab.favicon }],
  );
}
