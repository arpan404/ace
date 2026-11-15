import { panelPage, panelRows, type HomeRow, type ThreadsTab } from "@ace/ui-core";
import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import type { HomeList } from "./use-home-threads.ts";
import { useSettledPaging } from "./settled-paging.ts";

/** What Snoozed's and Settled's last row does: show a page more. */
export interface PanelPaging {
  more(): void;
  /** Older settled threads are on their way from the daemon. */
  loading: boolean;
  /** The last page of older settled threads failed: Show more retries it. */
  error: boolean;
}

const idle: PanelPaging = { more() {}, loading: false, error: false };
export const PanelPagingContext = createContext<PanelPaging>(idle);

type Paged = "snoozed" | "settled";
const firstPage: Record<Paged, number> = { snoozed: panelPage, settled: panelPage };

/**
 * The rows the Threads panel draws for its open tab: the Inbox, every thread with Unsent on top;
 * Snoozed and Settled, a page (`panelPage`) at a time. While the list's end is in view (the
 * list tells `onNearEnd`) the next page follows each one that has filled, as Show more adds one; Settled
 * asks the daemon for older settled threads when it has shown all it has loaded. Changing the
 * project or device filter starts both over.
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
}): {
  rows: readonly HomeRow[];
  paging: PanelPaging;
  /** For the list: whether its last rows are in view. */
  onNearEnd: (near: boolean) => void;
} {
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
  const filling = settled < shown.settled;
  const wanted = filling && settledPaging.hasMore && !settledPaging.loading && !settledPaging.error;
  const { more: loadMore, nextAt } = settledPaging;
  useEffect(() => {
    if (wanted) void loadMore();
    // `nextAt` moves with each page: while Settled still wants more, the next one is asked for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, nextAt]);
  const paged: Paged | undefined = tab === "inbox" ? undefined : tab;
  /** A page more of the open tab's threads, from what it holds: never a request. */
  const grow = useCallback(
    () =>
      setShown((current) => {
        const base = current.key === key ? current.shown : firstPage;
        return paged ? { key, shown: { ...base, [paged]: base[paged] + panelPage } } : current;
      }),
    [key, paged],
  );
  const paging = useMemo(
    (): PanelPaging => ({
      more() {
        // After a failed page, Show more asks again for the page it couldn't load.
        if (paged === "settled" && settledPaging.error) void loadMore();
        else grow();
      },
      loading: paged === "settled" && settledPaging.loading,
      error: paged === "settled" && settledPaging.error,
    }),
    [paged, settledPaging.loading, settledPaging.error, loadMore, grow],
  );
  const rows = useMemo(
    (): readonly HomeRow[] =>
      panelRows(panel, tab, {
        includeUnsent: true,
        ...(paged ? { shown: shown[paged] } : {}),
        moreOnDaemon: settledPaging.hasMore,
      }),
    [panel, tab, paged, shown, settledPaging.hasMore],
  );
  // The end in view shows the next page once this one has filled. Settled short of its page
  // waits for the daemon's; while searching it pages through the matches it draws, whatever the
  // daemon's page is doing. Scrolling never asks the daemon itself: only Show more retries a
  // failed page. The list says so for the rows it drew, so a page just added isn't taken as in
  // view before the list has drawn it, and each page drawn re-arms the next.
  const count = rows.length;
  const [nearAt, setNearAt] = useState<number>();
  const onNearEnd = useCallback((near: boolean) => setNearAt(near ? count : undefined), [count]);
  const short = paged === "settled" && panel.settled.length < shown.settled;
  const next = nearAt === count && rows.at(-1)?.kind === "more" && !short;
  useEffect(() => {
    if (next) grow();
  }, [next, grow]);
  return { rows, paging, onNearEnd };
}
