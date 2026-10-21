import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  listThreadAutomations,
  setThreadAutomationEnabled,
  type ThreadAutomation,
} from "./thread-automations-source.ts";

/*
 * Every thread's automations come from one shared read. The daemon publishes no automation
 * changes, so it is read again every minute, and every few seconds while a run is going. It
 * sits under the automations pages' key, so their writes refresh it too.
 */
const key = ["automations", "threads"] as const;
const runningPollMs = 5_000;
const idlePollMs = 60_000;
const none: readonly ThreadAutomation[] = [];

const running = (entries: readonly ThreadAutomation[] | undefined) =>
  entries?.some((entry) => entry.lastRun?.status === "running") ?? false;

/** The automations this thread owns, oldest list order kept. */
export function useThreadAutomations(threadId: string): readonly ThreadAutomation[] {
  const query = useDaemonQuery({
    queryKey: key,
    read: (client, signal) => listThreadAutomations(client, signal),
    refetchInterval: (state) => (running(state.state.data) ? runningPollMs : idlePollMs),
  });
  const { data } = query;
  return useMemo(() => {
    const own = data?.filter((entry) => entry.threadId === threadId);
    return own?.length ? own : none;
  }, [data, threadId]);
}

/** Pause or Resume; resolves once the daemon took it, a refusal said in a toast. */
export function useSetThreadAutomationEnabled() {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (id: string, enabled: boolean, revision: number | undefined) => {
      try {
        await setThreadAutomationEnabled(client, id, enabled, revision);
      } catch (error) {
        toast.error({
          title: enabled ? "Couldn't resume the automation" : "Couldn't pause the automation",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
      await queries.invalidateQueries({ queryKey: key });
    },
    [client, queries, toast],
  );
}
