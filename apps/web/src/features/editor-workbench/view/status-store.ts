import { useCallback, useSyncExternalStore } from "react";
import type { StatusReport } from "./deck-host.ts";

/**
 * Each group's latest status report, outside React state: a caret move tells the store, and only
 * the status line, which reads the focused group's report, draws again. The strips and groups
 * never hear it, so a status change costs the same however many tabs are open.
 */
export interface StatusStore {
  report(group: string, report: StatusReport | undefined): void;
  get(group: string): StatusReport | undefined;
  subscribe(listener: () => void): () => void;
}

export function createStatusStore(): StatusStore {
  const reports = new Map<string, StatusReport>();
  const listeners = new Set<() => void>();
  return {
    report(group, report) {
      const was = reports.get(group);
      if (was?.status === report?.status && was?.actions === report?.actions) return;
      if (report) reports.set(group, report);
      else reports.delete(group);
      for (const listener of listeners) listener();
    },
    get: (group) => reports.get(group),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The group's latest report, redrawing the caller when it changes. */
export function useStatusReport(store: StatusStore, group: string): StatusReport | undefined {
  const read = useCallback(() => store.get(group), [store, group]);
  return useSyncExternalStore(store.subscribe, read);
}
