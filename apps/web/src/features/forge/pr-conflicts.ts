import { useState } from "react";
import { useClient } from "@ace/client-react";
import {
  ThreadId,
  type ForgePrDetail,
  type GitConflicts,
  type GitConflictStep,
} from "@ace/protocol";
import { conflictRefusalText as refusalText } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { runCommand } from "@/lib/daemon-command.ts";
import { failureCode } from "@/lib/forge-read.ts";
import { useToast } from "@/components/ui/toast.tsx";

/**
 * The PR's merge conflicts, resolved in the linked task's checkout of it: merge the base in,
 * resolve each file by hand (or hand it to the agent), then commit and push the head branch.
 * Every step is a durable daemon command; the conflicts are read again after each one.
 */
export function usePrConflicts(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  /** The task whose checkout holds the PR; resolving goes through it. */
  threadId: string | undefined;
  enabled: boolean;
}) {
  const client = useClient();
  const toast = useToast();
  const ref = props.detail.status.ref;
  const [pending, setPending] = useState<string>();
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, ref, "conflicts", props.threadId],
    enabled: props.enabled && props.threadId !== undefined,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    read: async (reader, signal) => {
      const reply = await reader.request(
        {
          type: "workspace.request",
          operation: { op: "git.conflicts", threadId: ThreadId.parse(props.threadId), pr: ref },
        },
        { signal },
      );
      const result = reply.result;
      if (result.kind === "error")
        throw new Error(refusalText(result.code, props.detail.headBranch));
      if (result.kind !== "gitConflicts") throw new Error("No conflicts returned.");
      return result.conflicts;
    },
  });
  const conflicts: GitConflicts | null | undefined = query.isError ? undefined : query.data;
  const fail = (title: string, error: unknown) =>
    toast.error({ title, description: refusalText(failureCode(error), props.detail.headBranch) });
  /** Run one step; `key` names it so its own control shows it's working. */
  const step = async (key: string, title: string, input: GitConflictStep) => {
    if (!props.threadId || pending) return undefined;
    setPending(key);
    try {
      return await runCommand(client, {
        type: "git.conflicts",
        threadId: ThreadId.parse(props.threadId),
        pr: ref,
        step: input,
      });
    } catch (error) {
      fail(title, error);
      return undefined;
    } finally {
      await query.refetch();
      setPending(undefined);
    }
  };
  const push = async () => {
    if (!props.threadId || pending) return false;
    setPending("push");
    try {
      // Pushes the PR's head branch without force: a branch that moved on GitHub refuses.
      await runCommand(client, {
        type: "git.push",
        threadId: ThreadId.parse(props.threadId),
        remote: "origin",
      });
      toast.success({ title: `Pushed the merge to ${props.detail.headBranch}` });
      return true;
    } catch (error) {
      fail("Couldn't push the merge", error);
      return false;
    } finally {
      await query.refetch();
      setPending(undefined);
    }
  };
  return {
    query,
    conflicts,
    pending,
    async start(head: string) {
      const result = await step("start", "Couldn't merge the base", {
        action: "start",
        expectedHead: head,
      });
      if (result?.code === "merge_up_to_date")
        toast.info({ title: `Already up to date with ${props.detail.baseBranch}` });
    },
    abort: () => step("abort", "Couldn't abort the merge", { action: "abort" }),
    write: (path: string, content: string, revision: string) =>
      step(`write:${path}`, `Couldn't save ${path}`, { action: "write", path, content, revision }),
    take: (path: string, side: "ours" | "theirs") =>
      step(`take:${path}`, `Couldn't resolve ${path}`, { action: "take", path, side }),
    /** Commit the merge, then push it to the PR's head branch. */
    async finish(head: string) {
      const committed = await step("finish", "Couldn't commit the merge", {
        action: "commit",
        expectedHead: head,
      });
      return committed ? push() : false;
    },
    push,
  };
}
export type PrConflicts = ReturnType<typeof usePrConflicts>;
