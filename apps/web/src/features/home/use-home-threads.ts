import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import { useMemo } from "react";

const rank: Record<string, number> = {
  needs_you: 0,
  failed: 1,
  unresponsive: 1,
  working: 2,
  waiting: 2,
  new: 3,
  done: 3,
};

/** Order by obligation: needs you, then failing, then moving, then the rest; newest first. */
const readIds = (reader: SidebarReader): string[] =>
  reader.ids
    .flatMap((id) => {
      const entry = reader.thread(id);
      return entry && entry.archivedAt === undefined ? [entry] : [];
    })
    .toSorted(
      (a, b) =>
        (rank[a.status.state] ?? 3) - (rank[b.status.state] ?? 3) || b.updatedAt - a.updatedAt,
    )
    .map((entry) => entry.id);

const none: readonly string[] = [];

/** Every thread in Home order. Only the order is selected, so rows re-render on their own. */
export function useHomeThreadIds(): readonly string[] {
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  return useSidebar(keys, readIds, arrayEqual) ?? none;
}
