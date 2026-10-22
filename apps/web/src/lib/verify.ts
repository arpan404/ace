import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  verifyListLimit,
  verifySettled,
  type ForgeCheckLog,
  type VerifyResult,
  type VerifyRun,
  type VerifyTarget,
} from "@ace/protocol";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useDaemonQuery } from "./daemon-query.ts";

/*
 * Verify (ADR 0094): a project's local check runs and verified merge runs. One cached list per
 * project, read once and then kept current by the daemon's `verify.changed` pushes, each run
 * replaced only by a newer revision of itself.
 */

export interface VerifyRuns {
  /** Newest first. */
  runs: readonly VerifyRun[];
  /** The command runs use; null when the project has none. */
  command: string | null;
}

/** A Verify request the daemon refused, with its code (`no_command`, `busy`, `settled`...). */
export class VerifyRefused extends Error {
  readonly code: NonNullable<VerifyResult["error"]>;
  constructor(code: NonNullable<VerifyResult["error"]>) {
    super(`Verify refused: ${code}`);
    this.name = "VerifyRefused";
    this.code = code;
  }
}

export const verifyRunsKey = (workspaceId: string) => ["verify", workspaceId, "runs"] as const;

type Operation =
  | { action: "list"; workspaceId: string }
  | { action: "log"; runId: string }
  | { action: "start"; workspaceId: string; target: VerifyTarget }
  | { action: "cancel"; runId: string };

async function ask(client: ClientApi, op: Operation, signal?: AbortSignal) {
  const reply = await client.request({ type: "verify.request", op }, signal ? { signal } : {});
  if (!reply.ok) throw new VerifyRefused(reply.error ?? "unavailable");
  return reply;
}

/** `runs` with `run` in it: a newer revision replaces its older copy; a new run leads. */
export function withRun(current: VerifyRuns, run: VerifyRun): VerifyRuns {
  const at = current.runs.findIndex((each) => each.id === run.id);
  const old = current.runs[at];
  if (old) {
    if (old.revision >= run.revision) return current;
    return { ...current, runs: current.runs.with(at, run) };
  }
  return { ...current, runs: [run, ...current.runs].slice(0, verifyListLimit) };
}

function keep(cache: QueryClient, run: VerifyRun): void {
  cache.setQueryData<VerifyRuns>(verifyRunsKey(run.workspaceId), (current) =>
    current ? withRun(current, run) : current,
  );
}

/** A project's Verify runs and check command, kept current by the daemon's pushes. */
export function useVerifyRuns(workspaceId: string | undefined) {
  const client = useClient();
  const cache = useQueryClient();
  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type === "verify.changed") keep(cache, message.run);
      }),
    [client, cache],
  );
  return useDaemonQuery<VerifyRuns>({
    queryKey: verifyRunsKey(workspaceId ?? ""),
    enabled: !!workspaceId,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    retry: false,
    read: async (reader, signal) => {
      const reply = await ask(reader, { action: "list", workspaceId: workspaceId ?? "" }, signal);
      return { runs: reply.runs ?? [], command: reply.command ?? null };
    },
  });
}

/** Start and stop runs; the cache takes each answer at once, before its push arrives. */
export function useVerifyActions(workspaceId: string) {
  const client = useClient();
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const run = async (op: Operation): Promise<VerifyRun | undefined> => {
    setPending(true);
    try {
      const reply = await ask(client, op);
      if (reply.run) keep(cache, reply.run);
      return reply.run;
    } finally {
      setPending(false);
    }
  };
  return {
    pending,
    start: (target: VerifyTarget) => run({ action: "start", workspaceId, target }),
    cancel: (runId: string) => run({ action: "cancel", runId }),
  };
}

/** One run's output; read again with each revision while the run is live. */
export function useVerifyLog(run: VerifyRun | undefined) {
  const settled = run ? verifySettled.includes(run.state) : true;
  return useDaemonQuery<ForgeCheckLog>({
    queryKey: ["verify", "log", run?.id, settled ? "settled" : run?.revision],
    enabled: !!run,
    staleTime: settled ? Infinity : 0,
    retry: false,
    placeholderData: (previous) => previous,
    read: async (client, signal) => {
      const reply = await ask(client, { action: "log", runId: run?.id ?? "" }, signal);
      return reply.log ?? { text: "", truncated: false, errors: [], focus: null };
    },
  });
}

/** Whether a run has settled. */
export const isSettled = (run: VerifyRun) => verifySettled.includes(run.state);
