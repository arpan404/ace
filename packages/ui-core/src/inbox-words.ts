/*
 * GitHub notifications in words: why one arrived, what it is about, and where it opens. Pure,
 * so every client shows the same inbox.
 */

const reasonWords: Record<string, string> = {
  review_requested: "Review requested",
  mention: "Mentioned",
  team_mention: "Team mentioned",
  author: "Your thread",
  comment: "New comments",
  assign: "Assigned",
  state_change: "State changed",
  ci_activity: "CI activity",
  subscribed: "Watching",
  manual: "Subscribed",
  security_alert: "Security alert",
  invitation: "Invitation",
  approval_requested: "Approval requested",
  member_feature_requested: "Feature requested",
  security_advisory_credit: "Advisory credit",
};

/** The reasons the inbox's filter offers before any row names another, in GitHub's order. */
export const inboxReasons = [
  "review_requested",
  "mention",
  "team_mention",
  "assign",
  "author",
  "comment",
  "state_change",
  "ci_activity",
  "subscribed",
] as const;

function sentence(words: string): string {
  const text = words.trim().toLowerCase();
  return text ? text[0]?.toUpperCase() + text.slice(1) : "Other";
}

/** "Review requested", "Mentioned", "New comments"; a reason GitHub adds later in plain words. */
export function inboxReasonWords(reason: string): string {
  return reasonWords[reason] ?? sentence(reason.replace(/[_-]+/g, " "));
}

const typeWords: Record<string, string> = {
  PullRequest: "Pull request",
  Issue: "Issue",
  Release: "Release",
  Discussion: "Discussion",
  Commit: "Commit",
  CheckSuite: "Workflow run",
  RepositoryVulnerabilityAlert: "Security alert",
  RepositoryDependabotAlertsThread: "Dependabot alerts",
  RepositoryInvitation: "Invitation",
};

/** "Pull request", "Workflow run"; a type GitHub adds later split from its CamelCase name. */
export function inboxTypeWords(type: string): string {
  return typeWords[type] ?? sentence(type.replace(/([a-z\d])([A-Z])/g, "$1 $2"));
}

/** Where a row opens: ace's own pull request or issue page, or GitHub in the browser. */
export type InboxTarget =
  | { kind: "pull"; number: number }
  | { kind: "issue"; number: number }
  | { kind: "web"; url: string };

export function inboxTarget(row: {
  type: string;
  number?: number | undefined;
  url?: string | undefined;
  repository: { host: string; owner: string; name: string };
}): InboxTarget {
  if (row.number && row.type === "PullRequest") return { kind: "pull", number: row.number };
  if (row.number && row.type === "Issue") return { kind: "issue", number: row.number };
  return {
    kind: "web",
    url: row.url ?? `https://${row.repository.host}/${row.repository.owner}/${row.repository.name}`,
  };
}
