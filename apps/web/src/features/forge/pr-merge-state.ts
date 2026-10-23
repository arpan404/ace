import { useState } from "react";
import { useClient } from "@ace/client-react";
import {
  WorkspaceId,
  type CommandPayload,
  type ForgeMergeCommit,
  type ForgePrDetail,
} from "@ace/protocol";
import { actionErrorText, autoMergeBlocker, noAutoMerge, type MergeMethod } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { runCommand } from "@/lib/daemon-command.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { failureCode, readForge, writeFailure } from "@/lib/forge-read.ts";
import { useFreshSinceReconnect } from "./query-state.tsx";

export type MergeStateAction = "enable" | "disable" | "dequeue";
const actionLabels: Record<MergeStateAction, string> = {
  enable: "enable auto-merge",
  disable: "disable auto-merge",
  dequeue: "leave the merge queue",
};

/**
 * Auto-merge and merge-queue state as GitHub reports it, and the writes that change it. A write
 * whose result may have reached GitHub fences the next one until a fresh read settles it; a
 * clear refusal leaves the controls usable so the cause can be fixed.
 */
export function usePrMergeState(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  /** The task the PR is linked to; GitHub writes go through that link. */
  threadId: string | undefined;
  /** Outside a thread (the Pull requests page), auto-merge goes through the PR's project. */
  projectWrites?: boolean | undefined;
  writeDisabled: boolean;
  onRefresh(): void;
}) {
  const client = useClient();
  const toast = useToast();
  const ref = props.detail.status.ref;
  const active = props.detail.status.state === "open" || props.detail.status.state === "draft";
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const query = useDaemonQuery({
    // A new head is a new merge state (checks, mergeability): read it again then, not only on open.
    queryKey: ["forge", props.workspaceId, ref, "merge-state", props.detail.status.headSha],
    enabled: active,
    retry: false,
    gcTime: keptForgeMs,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        {
          op: "forge.pr.merge-state",
          workspaceId: props.workspaceId,
          repository: ref.repository,
          number: ref.number,
        },
        signal,
      );
      if (result.resource !== "prMergeState") throw new Error("No merge state returned.");
      return result.value;
    },
  });
  const state = query.isError ? undefined : query.data;
  const fresh = useFreshSinceReconnect(query.dataUpdatedAt);
  /** Why no merge-state write can run now, or undefined when one can. */
  const blocked =
    !props.threadId && !props.projectWrites
      ? "Link this pull request to a task first"
      : props.writeDisabled || !fresh || pending
        ? "Wait for GitHub to refresh"
        : query.isError || !state
          ? "Merge state is unavailable: refresh GitHub"
          : uncertain || state.writeState !== undefined
            ? "Refresh GitHub to confirm the previous change first"
            : undefined;
  const run = async (action: MergeStateAction, method: MergeMethod, commit?: ForgeMergeCommit) => {
    if (blocked || !state) return;
    // Only an enabled merge or squash writes a commit of its own.
    const message = commit && action === "enable" && method !== "rebase" ? { commit } : {};
    const payload: CommandPayload | undefined = props.threadId
      ? {
          type: "forge.pr.merge-state.change",
          link: { threadId: props.threadId, pr: ref },
          headSha: state.headSha,
          action,
          method,
          ...message,
        }
      : action === "dequeue"
        ? undefined
        : {
            type: "forge.hosted.merge-state",
            workspaceId: WorkspaceId.parse(props.workspaceId),
            pr: ref,
            headSha: state.headSha,
            action,
            method,
            ...message,
          };
    if (!payload) return;
    setPending(true);
    try {
      const result = await runCommand(client, payload);
      if (result.code)
        toast.error({
          title: `Couldn't ${actionLabels[action]}`,
          description: actionErrorText(result.code),
        });
    } catch (error) {
      const failure = writeFailure(error);
      setUncertain(failure.uncertain);
      toast.error({
        title: `Couldn't ${actionLabels[action]}`,
        // GitHub refuses auto-merge where the repository doesn't allow it: say that plainly.
        description:
          action === "enable" && failureCode(error) === "forge_forbidden"
            ? noAutoMerge
            : failure.text,
      });
    } finally {
      await query.refetch();
      props.onRefresh();
      setPending(false);
    }
  };
  return {
    query,
    state,
    pending,
    uncertain: uncertain || state?.writeState !== undefined,
    blocked,
    enableBlocked: blocked ?? autoMergeBlocker(state),
    run,
    /** A deliberate read: the only thing that lifts an uncertain write's fence. */
    async confirm() {
      if (!active) return true;
      const result = await query.refetch();
      if (result.isSuccess) setUncertain(false);
      return result.isSuccess;
    },
  };
}
export type PrMergeStateWrites = ReturnType<typeof usePrMergeState>;
