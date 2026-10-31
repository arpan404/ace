import { treeRows, type HomeRow } from "@ace/ui-core";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useNow } from "@/lib/time.ts";
import { useGracePages, useSettledPaging } from "./settled-paging.ts";
import { useSettledGrace, type HomeList } from "./use-home-threads.ts";

/**
 * The rows the Threads panel draws now: Pinned, then the project tree. Settled threads load back
 * to the grace period's boundary on their own, so each project shows the ones it settled
 * recently.
 */
export function usePanelRows(input: {
  list: HomeList;
  device: string | undefined;
}): readonly HomeRow[] {
  const { list } = input;
  const { project, collapsed, quietOpen, snoozedOpen } = useOrganizerState();
  const current = useParams({ strict: false, select: (params) => params.threadId });
  const now = useNow();
  const graceMs = useSettledGrace();
  useGracePages(useSettledPaging(project, input.device), now, graceMs);
  const { tree } = list;
  return useMemo(
    (): readonly HomeRow[] =>
      treeRows(tree, {
        includeUnsent: true,
        pinned: list.pinned,
        collapsed,
        quietOpen,
        snoozed: list.snoozed,
        snoozedOpen,
        current,
      }),
    [tree, list.pinned, list.snoozed, collapsed, quietOpen, snoozedOpen, current],
  );
}
