import { WorkspaceId } from "@ace/protocol";
import { browseIssues, browsePullRequests } from "../catalog/forge-browse.ts";
import { pullRequestDetails } from "../catalog/pull-request-details.ts";
import type { FakeDaemon } from "../daemon.ts";

/**
 * Hosted pull requests and issues for the fake app: the PR panel's three looks plus the
 * Pull requests view's lists for `ace`, whose issues can be commented on, closed and created.
 */
export function seedForgeBrowse(daemon: FakeDaemon, now: number, project = "ace"): void {
  const workspaceId = WorkspaceId.parse(project);
  daemon.workspace.seedPullRequests([...pullRequestDetails(now), ...browsePullRequests(now)]);
  for (const issue of browseIssues(now))
    for (const read of issue.reads)
      daemon.workspace.setForgeRead(
        read.resource === "issueTimeline"
          ? { op: "forge.issue.timeline", workspaceId, number: issue.number, page: 1 }
          : { op: "forge.issue.detail", workspaceId, number: issue.number },
        read,
      );
}
