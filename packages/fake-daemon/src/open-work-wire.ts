import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeBrowserOperation,
  type ForgeBrowserResult,
  type ForgeOpenWork,
} from "@ace/protocol";

/**
 * New thread's open work, put together from the lists a test seeded for the same project (the
 * open PRs, failing PRs and open issues reads), as the daemon's one request answers for them.
 * A list nobody seeded is empty.
 */
export function fakeOpenWork(
  op: Extract<ForgeBrowserOperation, { op: "forge.open-work" }>,
  read: (op: ForgeBrowserOperation) => ForgeBrowserResult | undefined,
): ForgeBrowserResult {
  const scope = {
    workspaceId: op.workspaceId,
    ...(op.repository ? { repository: op.repository } : {}),
  };
  const prs = (query: ForgePrSearch) => {
    const found = read({ op: "forge.pr.list", ...scope, query });
    return found?.resource === "prList"
      ? { items: found.value.items, total: found.value.total }
      : { items: [], total: 0 };
  };
  const issues = read({ op: "forge.issue.list", ...scope, query: ForgeIssueSearch.parse({}) });
  const value: ForgeOpenWork = {
    repository: op.repository ?? {
      forge: "github",
      host: "github.com",
      owner: "acme",
      name: op.workspaceId,
    },
    pullRequests: prs(ForgePrSearch.parse({ state: "active" })),
    failingPullRequests: prs(ForgePrSearch.parse({ state: "active", ci: "failure" })),
    issues:
      issues?.resource === "issueList"
        ? { items: issues.value.items, total: issues.value.total }
        : { items: [], total: 0 },
  };
  return { resource: "openWork", value };
}
