import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId, type CommandPayload, type ForgePrDetail } from "@ace/protocol";
import { actionErrorText, type MergeMethod } from "@ace/ui-core";
import { runCommand } from "@/lib/daemon-command.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { failureCode } from "@/lib/forge-read.ts";

const titles: Partial<Record<CommandPayload["type"], string>> = {
  "forge.pr.merge": "Couldn't merge this pull request",
  "forge.review.request": "Couldn't request a review",
  "forge.pr.link": "Couldn't link the task",
  "forge.pr.unlink": "Couldn't unlink the task",
};

/**
 * Writes that act through a task linked to the PR: merge, review requests, link and unlink.
 * A merge or review request holds every later write until a successful read shows what GitHub
 * did; the daemon's `writeState` keeps that hold across reloads.
 */
export function usePrLinkWrites(props: {
  detail: ForgePrDetail;
  threadId: string | undefined;
  writeReady: boolean;
  onRefresh(): Promise<boolean>;
}) {
  const client = useClient();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const ref = props.detail.status.ref;
  const fenced = reconciling || props.detail.writeState !== undefined;
  const run = async (payload: CommandPayload) => {
    const remote = payload.type === "forge.pr.merge" || payload.type === "forge.review.request";
    if (!ready || pending || !props.writeReady || (remote && fenced)) return;
    setPending(true);
    if (remote) setReconciling(true);
    try {
      const result = await runCommand(client, payload);
      if (result.code)
        toast.error({
          title: titles[payload.type] ?? "Couldn't save on GitHub",
          description: actionErrorText(result.code),
        });
    } catch (error) {
      toast.error({
        title: titles[payload.type] ?? "Couldn't save on GitHub",
        description: actionErrorText(failureCode(error) ?? "action_outcome_uncertain"),
      });
    } finally {
      try {
        if (await props.onRefresh()) setReconciling(false);
      } catch {
        // Keep the fence when the read fails; the daemon retains it across reloads.
      }
      setPending(false);
    }
  };
  const link = (threadId: string) => ({ threadId, pr: ref });
  return {
    pending,
    fenced,
    merge(method: MergeMethod) {
      if (!props.threadId) return Promise.resolve();
      return run({
        type: "forge.pr.merge",
        link: link(props.threadId),
        method,
        headSha: props.detail.status.headSha,
      });
    },
    requestReview(reviewers: string[]) {
      if (!props.threadId || !reviewers.length) return Promise.resolve();
      return run({ type: "forge.review.request", link: link(props.threadId), reviewers });
    },
    link: (threadId: string) => run({ type: "forge.pr.link", link: link(threadId) }),
    unlink: (threadId: string) =>
      run({
        type: "forge.pr.unlink",
        threadId: ThreadId.parse(threadId),
        number: ref.number,
        repo: ref.repository,
      }),
    /** A deliberate read that lifts the fence once GitHub's state is known again. */
    async reconcile(): Promise<boolean> {
      setPending(true);
      try {
        const ok = await props.onRefresh();
        if (ok) setReconciling(false);
        return ok;
      } catch {
        toast.error({ title: "GitHub is still unavailable", description: "Try again shortly." });
        return false;
      } finally {
        setPending(false);
      }
    },
  };
}
export type PrLinkWrites = ReturnType<typeof usePrLinkWrites>;
