import { WorkspaceId, type ForgeBrowserResult } from "@ace/protocol";
import { browseIssues, browsePullRequests } from "../catalog/forge-browse.ts";
import { inboxNotifications } from "../catalog/inbox.ts";
import { longIssueReads } from "../catalog/long-issue.ts";
import {
  projectIssues,
  projectNotifications,
  projectPullRequests,
} from "../catalog/forge-projects.ts";
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
  ]);
  daemon.workspace.inbox.seed(inboxNotifications(now));
  const rich = { number: 246, reads: richIssueReads(now) };
  const issues = [...browseIssues(now), rich].map((issue) => Object.assign(issue, { project }));
  seedIssues(daemon, issues);
}

/**
 * The design's other projects (billing-api, ace-mobile, docs-site) on top of `seedForgeBrowse`:
 * their pull requests, issues and notifications, so Code review's lists across every project
 * show several repositories.
 */
export function seedProjectForge(daemon: FakeDaemon, now: number): void {
  daemon.workspace.seedPullRequests([
    ...pullRequestDetails(now),
    ...browsePullRequests(now),
    richPullRequest(now),
    ...projectPullRequests(now),
  ]);
  daemon.workspace.inbox.seed(
    [...inboxNotifications(now), ...projectNotifications(now)].toSorted((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
  );
  seedIssues(daemon, projectIssues(now));
}

function seedIssues(
  daemon: FakeDaemon,
  issues: readonly { project: string; number: number; reads: readonly ForgeBrowserResult[] }[],
): void {
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

/** A busy issue, #260, whose conversation runs to three pages: for the newest-first view. */
export function seedLongIssue(daemon: FakeDaemon, now: number, project = "ace"): void {
  const workspaceId = WorkspaceId.parse(project);
  const long = longIssueReads(now);
  daemon.workspace.setForgeRead(
    { op: "forge.issue.detail", workspaceId, number: 260 },
    long.detail,
  );
  long.pages.forEach((read, index) =>
    daemon.workspace.setForgeRead(
      { op: "forge.issue.timeline", workspaceId, number: 260, page: index + 1 },
      read,
    ),
  );
}
