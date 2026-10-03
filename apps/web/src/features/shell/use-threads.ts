import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebarAll } from "@ace/client-react";
import { useCallback } from "react";

const none: readonly string[] = [];

/** Sidebar ids filtered by a predicate over each entry; re-runs when any entry changes. */
export function useThreadIdsWhere(
  predicate: (reader: SidebarReader, id: string) => boolean,
): readonly string[] {
  const selector = useCallback(
    (reader: SidebarReader) => reader.ids.filter((id) => predicate(reader, id)),
    [predicate],
  );
  return useSidebarAll(selector, arrayEqual) ?? none;
}
