import { searchRows, treeRows, type HomeRow } from "@ace/ui-core";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useNow } from "@/lib/time.ts";
import { useGracePages, useSettledPaging } from "./settled-paging.ts";
import { useSettledGrace, type HomeList } from "./use-home-threads.ts";
import type { SettledSearch } from "./use-panel-search.ts";

/**
 * The rows the Threads panel draws now: the search's matches while the person types, else the
 * tree. Settled threads load back to the grace period's boundary on their own, so each project
 * shows the ones it settled recently.
 */
export function usePanelRows(input: {
  list: HomeList;
  search: SettledSearch | undefined;
  device: string | undefined;
}): readonly HomeRow[] {
  const { list, search } = input;
  const { project, collapsed, quietOpen, snoozedOpen } = useOrganizerState();
  const current = useParams({ strict: false, select: (params) => params.threadId });
  const now = useNow();
  const graceMs = useSettledGrace();
  useGracePages(useSettledPaging(project, input.device), now, graceMs);
  const { tree } = list;
  return useMemo((): readonly HomeRow[] => {
    if (search)
      return searchRows(
        [...tree.order, ...list.snoozed],
        search.matches.map((item) => item.id),
      );
    return treeRows(tree, {
      includeUnsent: true,
      collapsed,
      quietOpen,
      snoozed: list.snoozed,
      snoozedOpen,
      current,
    });
  }, [search, tree, list.snoozed, collapsed, quietOpen, snoozedOpen, current]);
}
