import type { Sidebar, SidebarReader } from "@ace/client";
import { useCallback, useMemo } from "react";
import { useSidebarStore } from "./leases.ts";
import { arrayEqual, useSelection } from "./selection.ts";

export type SidebarKey = Parameters<Sidebar["select"]>[0][number];

/** Select from the shared thread list with the same key and equality rules as useThread. */
export function useSidebar<T>(
  keys: readonly SidebarKey[],
  selector: (reader: SidebarReader) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  const store = useSidebarStore();
  // Joined keys let callers pass a fresh array literal without re-subscribing.
  const keyList = keys.join("\u0000");
  const stableKeys = useMemo(() => keyList.split("\u0000") as SidebarKey[], [keyList]);
  const selection = useMemo(
    () => store?.select(stableKeys, selector, equal),
    [store, stableKeys, selector, equal],
  );
  return useSelection(selection);
}
const readIds = (reader: SidebarReader) => reader.ids;
export function useSidebarIds(): readonly string[] | undefined {
  return useSidebar(["ids"], readIds, arrayEqual);
}
const readLoaded = (reader: SidebarReader) => reader.loaded;
/** False until the thread list's first snapshot, so screens can show a skeleton, not "empty". */
export function useSidebarLoaded(): boolean {
  return useSidebar(["ids"], readLoaded) ?? false;
}
export function useSidebarThread(threadId: string) {
  const selector = useCallback((reader: SidebarReader) => reader.thread(threadId), [threadId]);
  return useSidebar([`thread:${threadId}`], selector);
}
