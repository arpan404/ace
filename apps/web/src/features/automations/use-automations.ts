import type { Automation } from "@ace/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useAutomationsSource, type AutomationEntry } from "./automations-source.ts";

/**
 * Automations are request/response reads (automation.list, automation.inbox), so they live
 * in TanStack Query. The source's change signal invalidates them, the way the daemon will
 * publish committed run changes.
 */
const keys = {
  all: ["automations"] as const,
  list: ["automations", "list"] as const,
  inbox: ["automations", "inbox"] as const,
};
export const inboxLimit = 50;

function useLiveInvalidation() {
  const source = useAutomationsSource();
  const queryClient = useQueryClient();
  useEffect(
    () => source.onChange(() => void queryClient.invalidateQueries({ queryKey: keys.all })),
    [source, queryClient],
  );
}

export function useAutomations() {
  const source = useAutomationsSource();
  useLiveInvalidation();
  return useQuery({ queryKey: keys.list, queryFn: () => source.list() });
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

export function useAutomationRuns() {
  const source = useAutomationsSource();
  useLiveInvalidation();
  return useQuery({ queryKey: keys.inbox, queryFn: () => source.inbox(inboxLimit) });
}

/** Writes. Each resolves once the source has committed; the change signal refreshes reads. */
export function useAutomationActions() {
  const source = useAutomationsSource();
  return useMemo(
    () => ({
      save: (automation: Automation) => source.put(automation),
      setEnabled: (automation: Automation, enabled: boolean) =>
        source.put({ ...automation, enabled }),
      remove: (id: string) => source.remove(id),
      runNow: (id: string) => source.run(id),
    }),
    [source],
  );
}
