import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import { useCallback, useMemo } from "react";

const none: readonly string[] = [];

/** Sidebar ids filtered by a predicate over each entry, watching only those entries' keys. */
export function useThreadIdsWhere(
  predicate: (reader: SidebarReader, id: string) => boolean,
): readonly string[] {
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  const selector = useCallback(
    (reader: SidebarReader) => reader.ids.filter((id) => predicate(reader, id)),
    [predicate],
  );
  return useSidebar(keys, selector, arrayEqual) ?? none;
}
const needsYou = (reader: SidebarReader, id: string) =>
  reader.thread(id)?.status.state === "needs_you";
export function useNeedsYouThreadIds(): readonly string[] {
  return useThreadIdsWhere(needsYou);
}

export interface WorkspaceGroup {
  workspaceId: string;
  threadIds: string[];
}
/** Threads grouped by workspace, newest first. Workspace never changes after creation. */
const readGroups = (reader: SidebarReader): WorkspaceGroup[] => {
  const groups = new Map<string, string[]>();
  for (const id of reader.ids.toReversed()) {
    const entry = reader.thread(id);
    if (!entry || entry.archivedAt !== undefined) continue;
    const list = groups.get(entry.workspaceId) ?? [];
    list.push(id);
    groups.set(entry.workspaceId, list);
  }
  return [...groups].map(([workspaceId, threadIds]) => ({ workspaceId, threadIds }));
};
const groupsEqual = (a: WorkspaceGroup[], b: WorkspaceGroup[]) =>
  a.length === b.length &&
  a.every(
    (group, i) =>
      group.workspaceId === b[i]?.workspaceId && arrayEqual(group.threadIds, b[i]?.threadIds),
  );
export function useWorkspaceGroups(): WorkspaceGroup[] {
  return useSidebar(["ids"], readGroups, groupsEqual) ?? [];
}
