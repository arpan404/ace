import type { ComponentProps } from "react";

import BranchToolbar from "../BranchToolbar";
import { GitHubIssueDialog } from "../GitHubIssueDialog";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";

export function ChatConversationExtras({
  branchToolbarProps,
  gitHubIssueDialogProps,
  pullRequestDialogKey,
  pullRequestDialogProps,
}: {
  branchToolbarProps: ComponentProps<typeof BranchToolbar> | null;
  gitHubIssueDialogProps: ComponentProps<typeof GitHubIssueDialog> | null;
  pullRequestDialogKey: string | number | null;
  pullRequestDialogProps: ComponentProps<typeof PullRequestThreadDialog> | null;
}) {
  return (
    <>
      {branchToolbarProps ? <BranchToolbar {...branchToolbarProps} /> : null}
      {gitHubIssueDialogProps ? <GitHubIssueDialog {...gitHubIssueDialogProps} /> : null}
      {pullRequestDialogProps ? (
        <PullRequestThreadDialog
          key={pullRequestDialogKey ?? undefined}
          {...pullRequestDialogProps}
        />
      ) : null}
    </>
  );
}
