import * as z from "zod/mini";
import { emptyHistory, type PageHistory } from "@ace/ui-core";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";
import { useScopedRecent, useScopedRecentStore, type ScopedRecent } from "../recent-store.ts";

/*
 * The Browser tool's local state. A thread has one live page on the daemon (the browser
 * service keeps one session per thread), and any number of browser tabs: each remembers its own
 * address and history, and the tab that last drove the page is the one showing it live.
 */

const History = z.object({ entries: z.array(z.string()), index: z.number() });

/** What a browser tab keeps with it across reloads. */
export const BrowserTabData = z.object({
  /** The page this tab shows or last showed. */
  url: z.optional(z.string()),
  history: z.optional(History),
  /** A device size from `viewports.ts`; absent follows the panel. */
  viewport: z.optional(z.string()),
  /** Opened with an address (the launcher, Suggested): go there once the tab shows. */
  go: z.optional(z.boolean()),
});
export type BrowserTabData = Omit<z.infer<typeof BrowserTabData>, "history"> & {
  history?: PageHistory | undefined;
};

export function browserTabData(tab: WorkspaceTab): BrowserTabData {
  const parsed = BrowserTabData.safeParse(tab.data);
  return parsed.success ? parsed.data : {};
}

export function tabHistory(data: BrowserTabData): PageHistory {
  return data.history ?? emptyHistory;
}

/** Addresses each thread's browser visited, for the address bar's suggestions. */
const visited = { key: "ace.browser.visited", perScope: 16, scopes: 64 };

export function useVisitedStore(): ScopedRecent {
  return useScopedRecentStore(visited);
}

export function useVisited(threadId: string): readonly string[] {
  return useScopedRecent(useVisitedStore(), threadId);
}
