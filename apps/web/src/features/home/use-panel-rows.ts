import { panelRows, type HomeRow, type ThreadsTab } from "@ace/ui-core";
import { useEffect, useMemo } from "react";
import type { HomeList } from "./use-home-threads.ts";
import { useSettledPaging } from "./settled-paging.ts";

/**
 * How many settled threads the Settled tab loads as it scrolls. Past them, older ones are
 * reached through search (⌘K), which asks the daemon.
 */
export const settledTabLimit = 100;

/**
 * The rows the Threads panel draws for its open tab: the Inbox with Unsent on top, Snoozed, or
 * Settled ending with a pointer to search while the daemon holds older settled threads back.
 */
export function usePanelRows(input: {
  list: HomeList;
  tab: ThreadsTab;
  /** The end of the list is in view: Settled loads its next page. */
  nearEnd: boolean;
  project: string | null;
  device: string | undefined;
}): readonly HomeRow[] {
  const { list, tab } = input;
  const paging = useSettledPaging(input.project, input.device);
  const settled = list.panel.settled.length;
  const ask =
    tab === "settled" &&
    input.nearEnd &&
    settled < settledTabLimit &&
    paging.hasMore &&
    !paging.loading &&
    !paging.error;
  const { more, nextAt } = paging;
  useEffect(() => {
    if (ask) void more();
    // `nextAt` moves with each page: while the end stays in view, the next one is asked for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, nextAt]);
  // Past the tab's own pages, or when a page can't load, search is the way to older ones.
  const older = paging.hasMore && (settled >= settledTabLimit || paging.error);
  return useMemo(
    (): readonly HomeRow[] =>
      panelRows(list.panel, tab, { includeUnsent: true, olderInSearch: older }),
    [list.panel, tab, older],
  );
}
