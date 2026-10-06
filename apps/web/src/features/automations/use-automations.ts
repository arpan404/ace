import type { Automation, AutomationRun } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  automationInbox,
  listAutomations,
  putAutomation,
  removeAutomation,
  runAutomation,
  type AutomationEntry,
} from "./automations-source.ts";

/*
 * Automations are request/response reads (automation.list, automation.inbox), so they live in
 * TanStack Query. The daemon publishes no automation changes, so writes refresh both reads, and
 * the inbox is read again every minute (every few seconds while a run is still going), which is
 * how scheduled and triggered runs reach the feed and the toasts.
 */
const keys = {
  all: ["automations"] as const,
  list: ["automations", "list"] as const,
  inbox: ["automations", "inbox"] as const,
};
export const inboxLimit = 50;
/** How often a running run's outcome is checked for, and how often new runs are. */
const runningPollMs = 5_000;
const idlePollMs = 60_000;

/** How long a deleted automation can be brought back from its toast. */
export const undoWindowMs = 6_000;

/**
 * Automations deleted on this device whose Undo window is still open: hidden from every list
 * at once, removed on the daemon only when the window closes. One set per query client.
 */
class Hidden {
  private ids: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();
  snapshot = () => this.ids;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(id: string, hidden: boolean) {
    if (this.ids.has(id) === hidden) return;
    const next = new Set(this.ids);
    if (hidden) next.add(id);
    else next.delete(id);
    this.ids = next;
    for (const listener of this.listeners) listener();
  }
}
const hiddenSets = new WeakMap<QueryClient, Hidden>();
function useHidden(): Hidden {
  const queries = useQueryClient();
  let hidden = hiddenSets.get(queries);
  if (!hidden) {
    hidden = new Hidden();
    hiddenSets.set(queries, hidden);
  }
  return hidden;
}

export function useAutomations() {
  const hidden = useHidden();
  const ids = useSyncExternalStore(hidden.subscribe, hidden.snapshot, hidden.snapshot);
  const select = useCallback(
    (entries: AutomationEntry[]) =>
      ids.size ? entries.filter((entry) => !ids.has(entry.automation.id)) : entries,
    [ids],
  );
  return useDaemonQuery({
    queryKey: keys.list,
    read: (client, signal) => listAutomations(client, signal),
    select,
  });
}

export function useAutomation(id: string): {
  entry: AutomationEntry | undefined;
  pending: boolean;
  error: unknown;
  retry(): void;
} {
  const query = useAutomations();
  const entry = useMemo(
    () => query.data?.find((candidate) => candidate.automation.id === id),
    [query.data, id],
  );
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return { entry, pending: query.isPending, error: query.error, retry };
}

const running = (runs: readonly AutomationRun[] | undefined) =>
  runs?.some((run) => run.status === "running") ?? false;

export function useAutomationRuns() {
  return useDaemonQuery({
    queryKey: keys.inbox,
    read: (client, signal) => automationInbox(client, inboxLimit, signal),
    refetchInterval: (query) => (running(query.state.data) ? runningPollMs : idlePollMs),
  });
}

/** Writes. Each resolves once the daemon has committed it, then both reads refresh. */
export function useAutomationActions() {
  const client = useClient();
  const queries = useQueryClient();
  const hidden = useHidden();
  return useMemo(() => {
    const refreshed = async <T>(write: Promise<T>): Promise<T> => {
      const result = await write;
      await queries.invalidateQueries({ queryKey: keys.all });
      return result;
    };
    return {
      save: (automation: Automation) => refreshed(putAutomation(client, automation)),
      setEnabled: (automation: Automation, enabled: boolean) =>
        refreshed(putAutomation(client, { ...automation, enabled })),
      remove: (id: string) => refreshed(removeAutomation(client, id)),
      /** Hide it here while its Undo window is open (`hidden`), or show it again. */
      setHidden: (id: string, value: boolean) => hidden.set(id, value),
      runNow: (id: string) => refreshed(runAutomation(client, id)),
    };
  }, [client, queries, hidden]);
}
