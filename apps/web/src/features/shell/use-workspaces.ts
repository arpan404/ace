import type { SidebarReader } from "@ace/client";
import { useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import { useMemo } from "react";

const none: readonly string[] = [];
const readWorkspaces = (reader: SidebarReader) =>
  [...new Set(reader.ids.flatMap((id) => reader.thread(id)?.workspaceId ?? []))].toSorted();
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Projects that have threads on this daemon, sorted. Live from the thread list. */
export function useWorkspaces(): readonly string[] {
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  return useSidebar(keys, readWorkspaces, sameList) ?? none;
}
