import { WorkspaceId } from "@ace/protocol";
import { browseIssues, browsePullRequests } from "../catalog/forge-browse.ts";
import { inboxNotifications } from "../catalog/inbox.ts";
import { projectIssues, projectPullRequests } from "../catalog/forge-projects.ts";
import { pullRequestDetails } from "../catalog/pull-request-details.ts";
import { richIssueReads, richPullRequest } from "../catalog/rich-content.ts";
import type { FakeDaemon } from "../daemon.ts";

/**
 * Hosted pull requests and issues for the fake app: the PR panel's three looks plus the
 * Pull requests view's lists for `ace` (whose issues can be commented on, closed and created)
 * and the design's other projects, and the person's GitHub notifications.
 */
export function seedForgeBrowse(daemon: FakeDaemon, now: number, project = "ace"): void {
  daemon.workspace.seedPullRequests([
    ...pullRequestDetails(now),
    ...browsePullRequests(now),
    richPullRequest(now),
    ...projectPullRequests(now),
  ]);
  daemon.workspace.inbox.seed(inboxNotifications(now));
  const rich = { number: 246, reads: richIssueReads(now) };
  const issues = [
    ...[...browseIssues(now), rich].map((issue) => Object.assign(issue, { project })),
    ...projectIssues(now),
  ];
  for (const issue of issues)
    for (const read of issue.reads)
      daemon.workspace.setForgeRead(
        read.resource === "issueTimeline"
          ? {
              op: "forge.issue.timeline",
              workspaceId: WorkspaceId.parse(issue.project),
              number: issue.number,
              page: 1,
            }
          : {
              op: "forge.issue.detail",
              workspaceId: WorkspaceId.parse(issue.project),
              number: issue.number,
            },
        read,
      );
}
