import type { ForgeIssueDetail, ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

/** GitHub's default label colours, for the labels the fixtures use. */
const palette: Record<string, string> = {
  bug: "d73a4a",
  enhancement: "a2eeef",
  documentation: "0075ca",
  docs: "0075ca",
  dependencies: "0366d6",
  web: "1d76db",
  client: "5319e7",
  providers: "fbca04",
  invoices: "0e8a16",
  "good first issue": "7057ff",
};

/** GitHub's colour for each fixture label that has one. */
export const colors = (labels: readonly string[]): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const label of labels) {
    const color = palette[label];
    if (color) found[label] = color;
  }
  return found;
};
const avatar = (login: string) => `https://avatars.githubusercontent.com/${login}`;
const avatarsOf = (people: readonly string[]) =>
  Object.fromEntries(people.map((person) => [person, avatar(person)]));

/** A catalog PR as GitHub's search and its GraphQL fields would list it. */
export function prRow(fixture: PullRequestFixture): ForgePrRow {
  const { detail } = fixture;
  const { status } = detail;
  const assignees = fixture.lifecycle.snapshot.metadata.assignees;
  const decision = detail.reviewDecision;
  return {
    ref: status.ref,
    title: status.title,
    url: status.url,
    author: detail.author,
    authorAvatarUrl: avatar(detail.author),
    state: status.state === "unknown" ? "open" : status.state,
    labels: detail.labels,
    labelColors: colors(detail.labels),
    ...(detail.createdAt ? { createdAt: detail.createdAt } : {}),
    updatedAt: detail.updatedAt ?? new Date(0).toISOString(),
    commentCount: status.comments.length,
    ci: status.ci,
    headBranch: detail.headBranch,
    baseBranch: detail.baseBranch,
    reviewDecision:
      decision === "APPROVED" || decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED"
        ? decision
        : null,
    assignees,
    reviewers: detail.reviewers,
    avatars: avatarsOf([detail.author, ...assignees, ...detail.reviewers]),
    ...(detail.additions === undefined ? {} : { additions: detail.additions }),
    ...(detail.deletions === undefined ? {} : { deletions: detail.deletions }),
    conflicting: status.mergeability === "conflicting",
  };
}

/** A known issue as GitHub's search lists it, with how many comments its timeline holds. */
export function issueRow(detail: ForgeIssueDetail, comments: number): ForgeIssueRow {
  const {
    body: _body,
    permissions: _p,
    relatedThreads: _r,
    relatedThreadsTruncated: _t,
    ...row
  } = detail;
  return {
    ...row,
    authorAvatarUrl: avatar(detail.author),
    labelColors: colors(detail.labels),
    commentCount: comments,
    avatars: avatarsOf([detail.author, ...detail.assignees]),
  };
}
