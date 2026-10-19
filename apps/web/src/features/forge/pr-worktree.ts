import { useState } from "react";
import * as z from "zod/mini";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId, type ForgePrDetail } from "@ace/protocol";
import { actionErrorText, outcomeUncertain, readJson, writeJson } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";
import { useWorktreeCreation } from "@/features/thread/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { failureCode } from "./source.ts";

/**
 * "Work on PR in this task": an isolated checkout of the PR head for an existing task. The
 * command id is kept on this device until its receipt settles, so a reload still shows its
 * progress.
 */
export function usePrWorktree(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  newId(): string;
  onRefresh(): void;
}) {
  const client = useClient();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const { storage } = useLayout();
  const [pending, setPending] = useState(false);
  const key = `ace.pr.worktree:${JSON.stringify([props.workspaceId, props.detail.status.ref])}`;
  const [commandId, setCommand] = useState(() =>
    readJson(storage, key, z.optional(z.string()), undefined),
  );
  const worktree = useWorktreeCreation(commandId);
  const settle = () => {
    try {
      storage?.removeItem?.(key);
    } catch {
      /* Private mode: nothing was persisted to forget. */
    }
  };
  const running =
    worktree.state?.progress?.state === "running" ||
    worktree.state?.progress?.state === "cancelling";
  const prepare = async (threadId: string) => {
    if (!ready || pending || running || !props.detail.headRepository) return;
    const id = props.newId();
    setCommand(id);
    writeJson(storage, key, id);
    setPending(true);
    try {
      const result = await client.command(
        {
          type: "forge.pr.worktree",
          threadId: ThreadId.parse(threadId),
          pullRequest: { ref: props.detail.status.ref, headSha: props.detail.status.headSha },
        },
        {},
        id,
      );
      if (!result.ok)
        toast.error({
          title: "Couldn't check out this pull request",
          description: actionErrorText(result.error ?? "action_failed"),
        });
      // The receipt settles it: forget the command unless its outcome is still unknown.
      if (result.ok || !outcomeUncertain(result.error)) settle();
      if (result.ok) props.onRefresh();
    } catch (error) {
      const code = failureCode(error);
      // Storage means this device never saved the command, so nothing was sent.
      if (code === "storage" || code === "not_dispatched") settle();
      toast.error({
        title: "Couldn't check out this pull request",
        description:
          code === "storage" || code === "not_dispatched"
            ? "This device couldn't save the request. Try again."
            : actionErrorText(code ?? "action_outcome_uncertain"),
      });
    } finally {
      setPending(false);
    }
  };
  return {
    state: worktree.state,
    act: worktree.act,
    /** Why it can't start now, or undefined when it can. */
    blocked: !props.detail.headRepository
      ? "The PR's head repository is unavailable"
      : pending || running
        ? "A checkout is already being prepared"
        : undefined,
    prepare,
  };
}
export type PrWorktree = ReturnType<typeof usePrWorktree>;
