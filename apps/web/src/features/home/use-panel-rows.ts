import { panelPage, panelRows, type HomeRow, type ThreadsTab } from "@ace/ui-core";
import { createContext, useEffect, useMemo, useState } from "react";
import type { HomeList } from "./use-home-threads.ts";
import { useSettledPaging } from "./settled-paging.ts";

/** What Snoozed's and Settled's last row does: show a page more, or back to the first page. */
export interface PanelPaging {
  more(): void;
  less(): void;
  /** Older settled threads are on their way from the daemon. */
  loading: boolean;
  /** The last page of older settled threads failed: Show more retries it. */
  error: boolean;
}

const idle: PanelPaging = { more() {}, less() {}, loading: false, error: false };
export const PanelPagingContext = createContext<PanelPaging>(idle);

type Paged = "snoozed" | "settled";
const firstPage: Record<Paged, number> = { snoozed: panelPage, settled: panelPage };

/**
 * The rows the Threads panel draws for its open tab: the Inbox, every thread with Unsent on top;
 * Snoozed and Settled, a page (`panelPage`) at a time. Show more adds a page, asking the daemon
 * for older settled threads when Settled has shown all it has loaded; Show less goes back to the
 * first page. Changing the project or device filter starts both over.
 */
export function usePanelRows(input: {
  list: HomeList;
  tab: ThreadsTab;
  project: string | null;
  device: string | undefined;
  /**
   * While searching, the settled threads that match, newest first: the list's own and older ones
   * the search found that it hasn't paged in (`useSettledSearch`).
   */
  settled?: readonly string[] | undefined;
}): { rows: readonly HomeRow[]; paging: PanelPaging } {
  const { list, tab } = input;
  const found = input.settled;
  const panel = useMemo(
    () => (found ? { ...list.panel, settled: [...found] } : list.panel),
    [list.panel, found],
  );
  const settledPaging = useSettledPaging(input.project, input.device);
  const key = JSON.stringify([input.project, input.device]);
  const [held, setShown] = useState({ key, shown: firstPage });
  const shown = held.key === key ? held.shown : firstPage;
  const settled = list.panel.settled.length;
  // Settled shows more than it has loaded: the daemon's next page fills it.
  const wanted =
    settled < shown.settled &&
    settledPaging.hasMore &&
    !settledPaging.loading &&
    !settledPaging.error;
  const { more: loadMore, nextAt } = settledPaging;
  useEffect(() => {
    if (wanted) void loadMore();
    // `nextAt` moves with each page: while Settled still wants more, the next one is asked for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, nextAt]);
  const paged: Paged | undefined = tab === "inbox" ? undefined : tab;
  const paging = useMemo((): PanelPaging => {
    const set = (to: (count: number) => number) =>
      setShown((current) => {
        const base = current.key === key ? current.shown : firstPage;
        return paged ? { key, shown: { ...base, [paged]: to(base[paged]) } } : current;
      });
    return {
      more() {
        // After a failed page, Show more asks again for the page it couldn't load.
        if (paged === "settled" && settledPaging.error) void loadMore();
        else set((count) => count + panelPage);
      },
      less: () => set(() => panelPage),
      loading: paged === "settled" && settledPaging.loading,
      error: paged === "settled" && settledPaging.error,
    };
  }, [key, paged, settledPaging.loading, settledPaging.error, loadMore]);
  const rows = useMemo(
    (): readonly HomeRow[] =>
      panelRows(panel, tab, {
        includeUnsent: true,
        ...(paged ? { shown: shown[paged] } : {}),
        moreOnDaemon: settledPaging.hasMore,
      }),
    [panel, tab, paged, shown, settledPaging.hasMore],
  );
  return { rows, paging };
}
