import { useState } from "react";
import type { z } from "zod";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  ForgeHostedLifecycleCommand,
  type ForgeLifecycleAction,
  type ForgePrDetail,
} from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { readForge } from "./source.ts";

/** What each lifecycle write is called wherever it shows: menu rows, result strips, toasts. */
export const lifecycleLabels: Record<ForgeLifecycleAction["kind"], string> = {
  edit: "Edit pull request",
  ready: "Ready for review",
  draft: "Convert to draft",
  close: "Close pull request",
  reopen: "Reopen pull request",
  "update.merge": "Update branch",
  "update.rebase": "Update with rebase",
  revert: "Revert changes",
};

type Operation = z.infer<typeof ForgeHostedLifecycleCommand>["operation"];

/**
 * The PR's lifecycle on GitHub: what this account may do to it now (draft, ready, close,
 * reopen, update, revert, edit) and the writes whose result GitHub hasn't confirmed. Every
 * write names the snapshot version it was chosen from, so a PR changed elsewhere refuses it.
 */
export function usePrLifecycle(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  writeDisabled: boolean;
  onRefresh(): void;
}) {
  const client = useClient();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const pr = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: [
      "forge",
      props.workspaceId,
      pr,
      "lifecycle",
      props.detail.status.headSha,
      props.detail.status.state,
      props.detail.status.title,
    ],
    retry: false,
    staleTime: 0,
    refetchOnReconnect: "always",
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        {
          op: "forge.pr.lifecycle",
          workspaceId: props.workspaceId,
          repository: pr.repository,
          number: pr.number,
        },
        signal,
      );
      if (result.resource !== "prLifecycle") throw new Error("No PR lifecycle response.");
      return result.value;
    },
  });
  const execute = async (operation: Operation, label: string): Promise<boolean> => {
    setPending(true);
    try {
      const result = await runCommand(
        client,
        ForgeHostedLifecycleCommand.parse({
          type: "forge.hosted.lifecycle",
          workspaceId: props.workspaceId,
          pr,
          operation,
        }),
      );
      const receipt = result.forgeLifecycle;
      if (!receipt) throw new Error("action_outcome_uncertain");
      if (receipt.outcome === "pending")
        toast.info({
          title: `${label}: waiting for GitHub`,
          description: "The result is pending.",
        });
      else if (receipt.outcome === "head_changed")
        toast.warning({
          title: `${label} stopped`,
          description: "The branch head changed. Review its new commits before trying again.",
        });
      else if (receipt.revertPr)
        toast.success({ title: `Opened draft revert PR #${receipt.revertPr.number}` });
      void query.refetch();
      props.onRefresh();
      return receipt.outcome === "accepted";
    } catch (error) {
      toast.error({
        title: `Couldn't ${label.toLowerCase()}`,
        description:
          error instanceof CommandRefused
            ? actionErrorText(error.code)
            : "Check the result before trying again. Your edit is kept.",
      });
      void query.refetch();
      return false;
    } finally {
      setPending(false);
    }
  };
  const snapshot = query.data?.snapshot;
  const unresolved = (query.data?.operations ?? []).filter(
    (op) => op.state === "pending" || op.state === "uncertain",
  );
  const blocked =
    !ready || pending || props.writeDisabled || !snapshot || query.isError || unresolved.length > 0;
  return {
    query,
    snapshot,
    unresolved,
    revertPrs: (query.data?.operations ?? []).flatMap((op) => (op.revertPr ? [op.revertPr] : [])),
    pending,
    blocked,
    /** Whether this account may take `kind` on the PR now. */
    can: (kind: Exclude<ForgeLifecycleAction["kind"], "edit">) =>
      !!snapshot?.actions.includes(kind),
    /** Apply `action` against the version it was chosen from (the current one by default). */
    apply: (action: ForgeLifecycleAction, version = snapshot?.version): Promise<boolean> =>
      version
        ? execute({ kind: "apply", expectedVersion: version, action }, lifecycleLabels[action.kind])
        : Promise.resolve(false),
    reconcile: (operationId: string) =>
      execute({ kind: "reconcile", operationId }, "Check the result"),
  };
}
export type PrLifecycle = ReturnType<typeof usePrLifecycle>;
