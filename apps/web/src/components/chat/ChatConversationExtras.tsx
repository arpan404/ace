import type { ComponentProps } from "react";

import { GitHubIssueDialog } from "../GitHubIssueDialog";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";

export function ChatConversationExtras({
  gitHubIssueDialogProps,
  pullRequestDialogKey,
  pullRequestDialogProps,
}: {
  gitHubIssueDialogProps: ComponentProps<typeof GitHubIssueDialog> | null;
  pullRequestDialogKey: string | number | null;
  pullRequestDialogProps: ComponentProps<typeof PullRequestThreadDialog> | null;
}) {
  return (
    <>
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
