import { useClient, useConnectionState } from "@ace/client-react";
import type { DiagnosticsRun } from "@ace/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { catalogKey } from "@/lib/model-catalog.ts";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import { useClock } from "@/lib/time.ts";

/** Longer than the daemon's largest integrity budget, so the daemon reports first. */
const CHECKS_TIMEOUT_MS = 16 * 60_000;
const checksRunKey = ["daemon", "checks-run"] as const;
const idle: DiagnosticsRun = { state: "idle" };

/** The daemon's run, and when it started by this window's clock (for "Checking for 12s"). */
interface ChecksRead {
  run: DiagnosticsRun;
  since: number | undefined;
}

/**
 * The daemon's checks run (Run checks, Run safe repairs), which outlives this page: opening the
 * page reads it, a run in progress is joined until it reports, and its report stays until the
 * next run. Leaving the page, switching tabs or reconnecting picks it up again.
 */
export function useChecksRun() {
  const client = useClient();
  const queries = useQueryClient();
  const ready = useConnectionState() === "ready";
  const clock = useClock();
  const [error, setError] = useState<string>();
  const status = useQuery({
    queryKey: checksRunKey,
    enabled: ready,
    staleTime: 0,
    queryFn: async (): Promise<ChecksRead> => {
      try {
        const result = await client.request({ type: "diagnostics.request", operation: "status" });
        const run = result.run ?? idle;
        return { run, since: run.state === "running" ? clock() - run.elapsedMs : undefined };
      } catch {
        // A daemon without the status read has nothing to come back to.
        return { run: idle, since: undefined };
      }
    },
  });
  const run = status.data?.run ?? idle;
  const running = run.state === "running" ? run : undefined;
  const operation = running?.operation;
  // Each run is joined once: a new one (another start time) is joined again.
  const runKey = running ? `${running.operation}:${running.startedAt}` : undefined;
  // While checks run, this page waits on them: the run it started, or one it came back to.
  useEffect(() => {
    if (!operation || !runKey || !ready) return;
    let live = true;
    void client
      .request(
        { type: "diagnostics.request", operation },
        // The integrity check scales with database size, up to 15 minutes on the daemon.
        { timeoutMs: CHECKS_TIMEOUT_MS },
      )
      .then(async (result) => {
        if (!live) return;
        setError(undefined);
        if (result.error === "diagnostics_busy") {
          setError("Other checks are running on this computer. Try again when they finish.");
          return;
        }
        if (!result.report || result.error) throw new Error("checks_failed");
        await client.request({ type: "providers.request", operation: "refresh" });
        // Discovery includes installed ACP agents as well as the built-in providers.
        await client.request({ type: "models.refresh", filter: {} }, { timeoutMs: 30_000 });
        await queries.invalidateQueries({ queryKey: catalogKey });
        refreshProviders(queries);
      })
      .catch(() => {
        if (live) setError("Couldn't finish the checks. Reconnect to this computer and try again.");
      })
      .finally(() => {
        if (live) void queries.invalidateQueries({ queryKey: checksRunKey });
      });
    return () => {
      live = false;
    };
  }, [operation, runKey, ready, client, queries]);
  return {
    run,
    /** When the running checks started, by this window's clock. */
    since: status.data?.since,
    error,
    /** Start checks; the daemon joins this to a run already going. */
    async start(next: "doctor" | "fix") {
      setError(undefined);
      // A status read still in flight mustn't put back the run this one replaces.
      await queries.cancelQueries({ queryKey: checksRunKey });
      const now = clock();
      queries.setQueryData<ChecksRead>(checksRunKey, {
        run: { state: "running", operation: next, startedAt: now, elapsedMs: 0 },
        since: now,
      });
    },
  };
}
