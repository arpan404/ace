import {
  focusRows,
  searchRows,
  treeRows,
  type HomeFocus,
  type HomeRow,
  type SettledFoot,
} from "@ace/ui-core";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useNow } from "@/lib/time.ts";
import { recentLeft, settledFoot, useRecentPages, useSettledPaging } from "./settled-paging.ts";
import type { HomeList } from "./use-home-threads.ts";
import type { SettledSearch } from "./use-panel-search.ts";

/**
 * The rows the Threads panel draws now: the search's matches while the person types, else the
 * focused list, else the tree. Settled threads load back to Recent's boundary on their own;
 * older ones load as a project's settled list scrolls into sight.
 */
export function usePanelRows(input: {
  list: HomeList;
  focus: HomeFocus | null;
  search: SettledSearch | undefined;
  device: string | undefined;
}): { rows: readonly HomeRow[]; more(): void } {
  const { list, focus, search } = input;
  const { project, collapsed, settledOpen, quietOpen, snoozedOpen } = useOrganizerState();
  const current = useParams({ strict: false, select: (params) => params.threadId });
  const now = useNow();
  const paging = useSettledPaging(project, input.device);
  useRecentPages(paging, now);
  const foot = settledFoot(paging);
  const { tree } = list;
  // While Recent still has days to load, its foot says so; past them it has none.
  const recentFoot: SettledFoot = recentLeft(paging, now) ? (foot ?? "loading") : undefined;
  const projectFoot = (id: string): SettledFoot => {
    const place = [...tree.projects, ...tree.quiet].find((each) => each.id === id);
    return place && place.settled.length < place.settledTotal ? foot : undefined;
  };
  const rows = useMemo((): readonly HomeRow[] => {
    if (search)
      return searchRows(
        [...tree.order, ...list.snoozed],
        search.matches.map((item) => item.id),
      );
    if (focus)
      return focusRows(focus, {
        tree,
        now,
        foot:
          focus.kind === "recent"
            ? recentFoot
            : focus.kind === "project" && focus.tab === "settled"
              ? projectFoot(focus.id)
              : undefined,
      });
    return treeRows(tree, {
      includeUnsent: true,
      collapsed,
      settledOpen,
      quietOpen,
      snoozed: list.snoozed,
      snoozedOpen,
      current,
      settledFoot: () => foot,
    });
    // projectFoot reads only tree and foot, both listed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [search, focus, tree, list.snoozed, now, recentFoot, foot, collapsed, settledOpen, quietOpen, snoozedOpen, current]);
  return { rows, more: () => void paging.more() };
}
