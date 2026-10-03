import type { Automation, AutomationRun } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
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

export function useAutomations() {
  return useDaemonQuery({
    queryKey: keys.list,
    read: (client, signal) => listAutomations(client, signal),
  });
}

export function useAutomation(id: string): {
  entry: AutomationEntry | undefined;
  pending: boolean;
  error: unknown;
} {
  const query = useAutomations();
  const entry = useMemo(
    () => query.data?.find((candidate) => candidate.automation.id === id),
    [query.data, id],
  );
  return { entry, pending: query.isPending, error: query.error };
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
      runNow: (id: string) => refreshed(runAutomation(client, id)),
    };
  }, [client, queries]);
}
