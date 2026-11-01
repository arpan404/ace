import { treeRows, type HomeRow } from "@ace/ui-core";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";
import type { HomeList } from "./use-home-threads.ts";

/**
 * The rows the Threads panel draws now: Active on top, then the project tree with each
 * project's settled threads. Settled threads the daemon holds back stay in History, which each
 * project's last row points to.
 */
export function usePanelRows(input: { list: HomeList }): readonly HomeRow[] {
  const { list } = input;
  const { collapsed, quietOpen, snoozedOpen } = useOrganizerState();
  const current = useParams({ strict: false, select: (params) => params.threadId });
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
