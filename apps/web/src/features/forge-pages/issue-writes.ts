import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  CommandId,
  WorkspaceId,
  type ForgeIssueAction,
  type ForgeIssueRef,
  type ForgeIssueWrite,
  type ForgeRepository,
} from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast.tsx";
import { CommandRefused, runCommand } from "@/lib/daemon-command.ts";
import { failureCode } from "@/lib/forge-read.ts";

const titles: Record<ForgeIssueWrite["action"], string> = {
  create: "Couldn't create the issue",
  comment: "Couldn't post the comment",
  edit: "Couldn't save the issue",
  state: "Couldn't change the issue",
};

/** A write the daemon dispatched without hearing back: it may have landed, and is never resent. */
const uncertain = new Set(["action_outcome_uncertain", "forge_write_uncertain"]);

/**
 * Issue writes through the user's own `gh`: create, comment, edit, close and reopen. Each one
 * has its own command id, which the daemon journals, so a write whose answer was lost is checked
 * against GitHub (`reconcile`) instead of being sent twice. Lists and the issue read again after.
 */
export function useIssueWrites(project: string, repository: ForgeRepository | undefined) {
  const client = useClient();
  const cache = useQueryClient();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: ["forge", project, "browse"] });
  const reconcile = async (actionId: string): Promise<ForgeIssueAction | undefined> => {
    if (!repository) return undefined;
    try {
      const result = await client.command({
        type: "forge.issue.reconcile",
        workspaceId: WorkspaceId.parse(project),
        repository,
        actionId: CommandId.parse(actionId),
      });
      return result.issueAction;
    } finally {
      await refresh();
    }
  };
  const write = async (input: ForgeIssueWrite): Promise<ForgeIssueRef | undefined> => {
    if (!repository || !ready || pending) return undefined;
    setPending(true);
    const id = crypto.randomUUID();
    try {
      const result = await runCommand(
        client,
        { type: "forge.issue.write", workspaceId: WorkspaceId.parse(project), repository, input },
        id,
      );
      return (
        result.issue ??
        result.issueAction?.issue ??
        (input.action === "create" ? undefined : { repository, number: input.number })
      );
    } catch (error) {
      const code =
        error instanceof CommandRefused ? error.code : (failureCode(error) ?? "command_failed");
      if (uncertain.has(code))
        toast.error({
          title: "GitHub didn't confirm it",
          description: "It may have gone through. Check before trying again.",
          actionProps: {
            children: "Check GitHub",
            onClick: () => void reconcile(id).catch(() => {}),
          },
        });
      else toast.error({ title: titles[input.action], description: actionErrorText(code) });
      return undefined;
    } finally {
      setPending(false);
      await refresh();
    }
  };
  return { ready: ready && !!repository, pending, write, reconcile };
}
export type IssueWrites = ReturnType<typeof useIssueWrites>;
