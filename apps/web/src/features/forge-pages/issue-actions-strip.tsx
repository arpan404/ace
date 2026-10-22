import type { ForgeIssueAction, ForgeIssueDetail } from "@ace/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import type { IssueWrites } from "./issue-writes.ts";

const words: Record<ForgeIssueAction["action"], string> = {
  create: "The new issue",
  comment: "A comment",
  edit: "An edit",
  state: "Closing or reopening",
};

/**
 * Writes to this issue whose outcome GitHub never confirmed, from any device and across restarts:
 * each is checked against GitHub on request and never sent again blindly.
 */
export function IssueActionsStrip(props: {
  project: string;
  issue: ForgeIssueDetail;
  writes: IssueWrites;
}) {
  const { issue } = props;
  const cache = useQueryClient();
  const key = [
    "forge",
    props.project,
    "browse",
    "issueActions",
    issue.ref.number,
    repositoryParam(issue.ref.repository),
  ];
  const query = useDaemonQuery<ForgeIssueAction[]>({
    queryKey: key,
    staleTime: 15_000,
    retry: false,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        {
          op: "forge.issue.actions",
          workspaceId: props.project,
          repository: issue.ref.repository,
          number: issue.ref.number,
        },
        signal,
      );
      if (value.resource !== "issueActions") throw new Error("No issue actions.");
      return value.actions;
    },
  });
  const open = (query.data ?? []).filter(
    (action) => action.state === "uncertain" || action.state === "pending",
  );
  if (!open.length) return null;
  return (
    <ul aria-label="Unconfirmed changes" className="mt-4 flex flex-col gap-1">
      {open.map((action) => (
        <li
          key={action.id}
          role="status"
          className="flex items-center gap-2 text-ui text-muted-foreground"
        >
          <span data-tone="needs-you" className="size-1.5 shrink-0 rounded-full bg-(--tone)" />
          <span className="min-w-0 flex-1 truncate">
            {words[action.action]}{" "}
            {action.state === "pending" ? "is still being sent." : "wasn't confirmed by GitHub."}
          </span>
          {action.state === "uncertain" && (
            <Button
              size="xs"
              variant="ghost"
              disabled={!props.writes.ready}
              onClick={() =>
                void props.writes
                  .reconcile(action.id)
                  .finally(() => cache.invalidateQueries({ queryKey: key }))
              }
            >
              Check GitHub
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
