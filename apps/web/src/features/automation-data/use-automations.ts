import type { Automation, AutomationRun, AutomationSource } from "@ace/protocol";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  automationInbox,
  automationHistory,
  listAutomations,
  putAutomation,
  removeAutomation,
  retryAutomation,
  runAutomation,
  setEnabledAutomation,
  type AutomationEntry,
  type RunRequest,
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

/** Both lists in one read: the person's automations and the ones agents made from threads. */
export function useAutomationLists() {
  return useDaemonQuery({
    queryKey: keys.list,
    read: (client, signal) => listAutomations(client, signal),
    refetchInterval: idlePollMs,
  });
}

/** The person's own automations. */
export function useAutomations() {
  const query = useAutomationLists();
  return { ...query, data: query.data?.person };
}

/** One automation by id, the person's first, else one an agent made from a thread. */
export function useAutomation(id: string): {
  entry: AutomationEntry | undefined;
  pending: boolean;
  error: unknown;
  retry(): void;
} {
  const query = useAutomationLists();
  const entry = useMemo(
    () =>
      query.data?.person.find((candidate) => candidate.automation.id === id) ??
      query.data?.threads.find((candidate) => candidate.automation.id === id),
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

export function useAutomationHistory(id: string, source: AutomationSource = "person") {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const query = useInfiniteQuery({
    queryKey: [...keys.inbox, id, source],
    enabled: ready,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => automationHistory(client, id, source, pageParam, signal),
    getNextPageParam: (page) => page.before ?? undefined,
    refetchInterval: (state) =>
      state.state.data?.pages.some((page) => running(page.runs)) ? runningPollMs : idlePollMs,
  });
  const runs = useMemo(() => query.data?.pages.flatMap((page) => page.runs), [query.data]);
  return { ...query, runs };
}

/** Writes. Each resolves once the daemon has committed it, then both reads refresh. */
export function useAutomationActions() {
  const client = useClient();
  const queries = useQueryClient();
  return useMemo(() => {
    const refreshed = async <T>(write: Promise<T>): Promise<T> => {
      const result = await write;
      void queries.invalidateQueries({ queryKey: keys.all });
      return result;
    };
    return {
      save: (automation: Automation, expectedRevision?: number | null | undefined) =>
        refreshed(putAutomation(client, automation, expectedRevision)),
      setEnabled: (
        id: string,
        enabled: boolean,
        expectedRevision?: number | undefined,
        source?: AutomationSource,
      ) => refreshed(setEnabledAutomation(client, id, enabled, expectedRevision, source)),
      remove: (
        id: string,
        expectedRevision?: number | null | undefined,
        source?: AutomationSource,
      ) => refreshed(removeAutomation(client, id, expectedRevision, source)),
      retry: (id: string, expectedRevision?: number | undefined) =>
        refreshed(retryAutomation(client, id, expectedRevision)),
      runNow: (id: string, request?: RunRequest) => refreshed(runAutomation(client, id, request)),
    };
  }, [client, queries]);
}
