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
import { inboxKey } from "./inbox-data.ts";
import { freshenIssueLists } from "./issue-freshen.ts";

const titles: Record<ForgeIssueWrite["action"], string> = {
  create: "Couldn't create the issue",
  comment: "Couldn't post the comment",
  edit: "Couldn't save the issue",
  state: "Couldn't change the issue",
  labels: "Couldn't change the labels",
  assignees: "Couldn't change the assignees",
  milestone: "Couldn't change the milestone",
};

/** A write the daemon dispatched without hearing back: it may have landed, and is never resent. */
const uncertain = new Set(["action_outcome_uncertain", "forge_write_uncertain"]);

/**
 * Issue writes through the user's own `gh`: create, comment, edit, close and reopen. Each one
 * has its own command id, which the daemon journals, so a write whose answer was lost is checked
 * against GitHub (`reconcile`) instead of being sent twice. After each, the issue reads again,
 * and every list, the Inbox and the sidebar's open issues are brought up to date with it.
 */
export function useIssueWrites(project: string, repository: ForgeRepository | undefined) {
  const client = useClient();
  const cache = useQueryClient();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [pending, setPending] = useState(false);
  const refresh = async () => {
    // The issue's own read lands first (it's on screen), then lists take its word for it.
    await cache.invalidateQueries({ queryKey: ["forge", project, "browse"] });
    freshenIssueLists(cache, project);
    await Promise.all(
      [inboxKey(project), ["forge", project, "openIssues"], ["forge", project, "openWork"]].map(
        (queryKey) => cache.invalidateQueries({ queryKey }),
      ),
    );
  };
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
      else if (code === "forge_conflict")
        toast.error({
          title: "Someone else changed it first",
          description: "The issue now shows their change. Yours is kept here to save again.",
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
