import { useSyncExternalStore } from "react";
import type { Selection } from "@ace/client";
export function useSelection<T>(selection: Selection<T>): T {
  return useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
}
export function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
