import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import type { DiagnosticRepair, DiagnosticReport, DiagnosticsRun } from "@ace/protocol";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { catalogKey } from "@/lib/model-catalog.ts";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import { useClock } from "@/lib/time.ts";

/** Longer than the daemon's largest integrity budget, so the daemon reports first. */
const CHECKS_TIMEOUT_MS = 16 * 60_000;
const checksRunKey = ["daemon", "checks-run"] as const;
const idle: DiagnosticsRun = { state: "idle" };
const failedText = "Couldn't finish the checks. Reconnect to this computer and try again.";
const busyText = "Other checks are running on this computer. Try again when they finish.";

/** The daemon's run as this page knows it. */
interface ChecksRead {
  run: DiagnosticsRun;
  /** When the running checks started, by this window's clock (for "Checking for 12s"). */
  since: number | undefined;
  /** This page started the run and waits on its own request, so it doesn't join it too. */
  own?: boolean;
}

/** A checks reply that ended the run: its report, kept as the last run's outcome. */
interface Finished {
  operation: "doctor" | "fix";
  id: string;
  startedAt: number;
  finishedAt: number;
  report: DiagnosticReport;
  repairs: DiagnosticRepair[] | undefined;
}

/**
 * Keep a finished run's report from the reply itself, so it shows even where the daemon can't
 * be asked for its status, then refresh what checks can change: providers and their models.
 */
async function finished(client: ClientApi, queries: QueryClient, run: Finished) {
  queries.setQueryData<ChecksRead>(checksRunKey, {
    run: {
      state: "done",
      id: run.id,
      operation: run.operation,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      report: run.report,
      ...(run.repairs ? { repairs: run.repairs } : {}),
    },
    since: undefined,
  });
  await client.request({ type: "providers.request", operation: "refresh" });
  // Discovery includes installed ACP agents as well as the built-in providers.
  await client.request({ type: "models.refresh", filter: {} }, { timeoutMs: 30_000 });
  await queries.invalidateQueries({ queryKey: catalogKey });
  refreshProviders(queries);
}

/** The run this page started didn't go; the status read (where there is one) says what did. */
function notRunning(queries: QueryClient) {
  queries.setQueryData<ChecksRead>(checksRunKey, { run: idle, since: undefined });
}

/**
 * The daemon's checks run (Run checks, Run safe repairs), which outlives this page. Run checks
 * starts one with its own request. Opening the page reads the run, and a run in progress is
 * joined by its id, which never starts work: a run that ended in the meantime answers with its
 * outcome, one that is gone (a restart) just reads the status again. The last report stays until
 * the next run, kept from the reply where the daemon can't report its status.
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
      const known = queries.getQueryData<ChecksRead>(checksRunKey);
      try {
        const result = await client.request({ type: "diagnostics.request", operation: "status" });
        // A daemon without the status read keeps what this page already knows.
        if (!result.run) return known ?? { run: idle, since: undefined };
        const run = result.run;
        return { run, since: run.state === "running" ? clock() - run.elapsedMs : undefined };
      } catch {
        return known ?? { run: idle, since: undefined };
      }
    },
  });
  const run = status.data?.run ?? idle;
  // A run this page read (not one it started and waits on) is joined by its id, once.
  const joining = run.state === "running" && status.data?.own !== true ? run : undefined;
  const joinId = joining?.id;
  const joinOperation = joining?.operation;
  const joinStartedAt = joining?.startedAt;
  useEffect(() => {
    if (!joinId || !joinOperation || joinStartedAt === undefined || !ready) return;
    let live = true;
    void client
      .request(
        { type: "diagnostics.request", operation: "join", runId: joinId },
        // The integrity check scales with database size, up to 15 minutes on the daemon.
        { timeoutMs: CHECKS_TIMEOUT_MS },
      )
      .then(async (result) => {
        if (!live) return;
        setError(undefined);
        // Gone (an older run, or one from before a restart): the status read says what's now.
        if (result.error === "diagnostics_run_gone") return;
        if (!result.report || result.error) throw new Error("checks_failed");
        await finished(client, queries, {
          operation: joinOperation,
          id: joinId,
          startedAt: joinStartedAt,
          finishedAt: clock(),
          report: result.report,
          repairs: result.repairs,
        });
      })
      .catch(() => {
        if (live) setError(failedText);
      })
      .finally(() => {
        if (live) void queries.invalidateQueries({ queryKey: checksRunKey });
      });
    return () => {
      live = false;
    };
  }, [joinId, joinOperation, joinStartedAt, ready, client, queries, clock]);
  return {
    run,
    /** When the running checks started, by this window's clock. */
    since: status.data?.since,
    error,
    /** Start checks; the daemon joins this to a run of the same kind already going. */
    async start(operation: "doctor" | "fix") {
      setError(undefined);
      // A status read still in flight mustn't put back the run this one replaces.
      await queries.cancelQueries({ queryKey: checksRunKey });
      const startedAt = clock();
      queries.setQueryData<ChecksRead>(checksRunKey, {
        run: { state: "running", id: "", operation, startedAt, elapsedMs: 0 },
        since: startedAt,
        own: true,
      });
      try {
        const result = await client.request(
          { type: "diagnostics.request", operation },
          { timeoutMs: CHECKS_TIMEOUT_MS },
        );
        if (result.error === "diagnostics_busy") {
          setError(busyText);
          notRunning(queries);
        } else if (!result.report || result.error) throw new Error("checks_failed");
        else
          await finished(client, queries, {
            operation,
            id: "",
            startedAt,
            finishedAt: clock(),
            report: result.report,
            repairs: result.repairs,
          });
      } catch {
        setError(failedText);
        notRunning(queries);
      } finally {
        await queries.invalidateQueries({ queryKey: checksRunKey });
      }
    },
  };
}
