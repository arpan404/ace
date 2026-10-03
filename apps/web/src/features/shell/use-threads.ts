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
