import { useState } from "react";
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ForgeHostedChecksCommand,
  type ForgeCheck,
  type ForgeCheckAction,
  type ForgeCheckRun,
  type ForgePrRef,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge, writeFailure } from "@/lib/forge-read.ts";
import { runCommand } from "@/lib/daemon-command.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { checkRunId } from "@ace/ui-core";

/*
 * One check run, read only when the panel opens it. Its key names the PR (so the panel's
 * Refresh reads it again), the run and the check's state: a finished run never changes, a
 * running one is read again once its state moves.
 */

function checkKey(workspaceId: string, pr: ForgePrRef, check: ForgeCheck) {
  return ["forge", workspaceId, pr, "check", check.id, check.status] as const;
}

async function readCheckRun(
  client: ClientApi,
  input: { workspaceId: string; pr: ForgePrRef; check: ForgeCheck },
  signal: AbortSignal,
): Promise<ForgeCheckRun> {
  const id = checkRunId(input.check);
  if (id === undefined) throw new Error("This check has no run to read.");
  const value = await readForge(
    client,
    {
      op: "forge.pr.check",
      workspaceId: input.workspaceId,
      repository: input.pr.repository,
      checkRunId: id,
      ...(input.check.jobId ? { jobId: input.check.jobId } : {}),
    },
    signal,
  );
  if (value.resource !== "prCheck") throw new Error("No check run.");
  return value.value;
}

export function useCheckRun(input: {
  workspaceId: string;
  pr: ForgePrRef;
  check: ForgeCheck;
  enabled: boolean;
}) {
  const finished = input.check.status !== "pending";
  return useDaemonQuery({
    queryKey: checkKey(input.workspaceId, input.pr, input.check),
    enabled: input.enabled && checkRunId(input.check) !== undefined,
    retry: false,
    staleTime: finished ? Infinity : 0,
    read: (client, signal) => readCheckRun(client, input, signal),
  });
}

/** The same read for "Fix with agent" from elsewhere in the panel, shared with an open one. */
export function useFetchCheckRun(workspaceId: string, pr: ForgePrRef) {
  const client = useClient();
  const cache = useQueryClient();
  return (check: ForgeCheck) =>
    cache.fetchQuery({
      queryKey: checkKey(workspaceId, pr, check),
      staleTime: check.status === "pending" ? 0 : Infinity,
      queryFn: ({ signal }) => readCheckRun(client, { workspaceId, pr, check }, signal),
    });
}

/** Re-runs a workflow run; the PR reads again after, so its checks show running. */
export function useCheckRerun(input: {
  workspaceId: string;
  pr: ForgePrRef;
  onDone(): void | Promise<unknown>;
}) {
  const client = useClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async (action: ForgeCheckAction) => {
    if (pending) return;
    setPending(true);
    try {
      await runCommand(
        client,
        ForgeHostedChecksCommand.parse({
          type: "forge.hosted.checks",
          workspaceId: input.workspaceId,
          pr: input.pr,
          action,
        }),
      );
      await input.onDone();
    } catch (error) {
      const failure = writeFailure(error);
      toast.error({
        title:
          action.kind === "cancel"
            ? failure.uncertain
              ? "Couldn't confirm the cancel"
              : "Couldn't cancel the run"
            : failure.uncertain
              ? "Couldn't confirm the re-run"
              : "Couldn't re-run the checks",
        description: failure.text,
      });
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}
