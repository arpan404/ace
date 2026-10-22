import { lifecycleRecord, type Fixtures } from "./fixtures.ts";
import { sha } from "./identities.ts";

const closing = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
/** An issue of octo/ace as a closing reference. */
export function closingIssue(number: number, state = "OPEN") {
  return {
    number,
    title: `Issue ${number}`,
    state,
    url: `https://github.com/octo/ace/issues/${number}`,
    repository: { name: "ace", owner: { login: "octo" } },
  };
}
/** The milestone, lock, branch and closing-issue facts a current host adds to a snapshot. */
export function extraRecord(
  overrides: {
    state?: string;
    milestone?: { number: number; title: string; state: string; dueOn: string | null } | null;
    locked?: boolean;
    activeLockReason?: string | null;
    headRefName?: string;
    headRef?: { name: string } | null;
    isCrossRepository?: boolean;
    viewerCanDeleteHeadRef?: boolean;
    closing?: unknown[];
    manual?: unknown[];
    /** Open PRs, this one included, whose head is the branch. */
    openOnHead?: number[];
  } = {},
) {
  const { closing: issues = [], manual = [], openOnHead = [], headRef, ...rest } = overrides;
  const ref = headRef === undefined ? { name: "feature/fix" } : headRef;
  return {
    ...lifecycleRecord(rest.state ? { state: rest.state } : {}),
    milestone: null,
    locked: false,
    activeLockReason: null,
    headRefName: "feature/fix",
    isCrossRepository: false,
    viewerCanDeleteHeadRef: true,
    closingIssuesReferences: closing(issues),
    manualClosingIssues: closing(manual),
    ...rest,
    headRef: ref && {
      ...ref,
      associatedPullRequests: { nodes: openOnHead.map((number) => ({ number })) },
    },
  };
}
/** Snapshots answered in order, from a host that reports the extra facts. */
export function extraFixtures(
  records: ReturnType<typeof extraRecord>[],
  repository: { permission?: string; deleteBranchOnMerge?: boolean; defaultBranch?: string } = {},
): Fixtures {
  return {
    "graphql:query AceLifecycleSnapshot": records.map((pullRequest) => ({
      body: {
        data: {
          repository: {
            isArchived: false,
            viewerPermission: repository.permission ?? "WRITE",
            deleteBranchOnMerge: repository.deleteBranchOnMerge ?? false,
            defaultBranchRef: { name: repository.defaultBranch ?? "main" },
            pullRequest,
          },
          mutationType: {
            fields: [
              "updatePullRequest",
              "closePullRequest",
              "reopenPullRequest",
              "addCloseIssueReferences",
              "removeCloseIssueReferences",
            ].map((name) => ({ name })),
          },
        },
      },
    })),
  };
}
/** The head branch as GitHub reads it: at `at`, or deleted. */
export function headRef(branch: string, at: string | null = sha) {
  return {
    [`repos/octo/ace/git/ref/heads/${branch}`]: [
      at === null
        ? { status: 404, body: { message: "Not Found" } }
        : { body: { object: { sha: at } } },
    ],
  };
}

/** GitHub's open PRs whose head is `branch` in octo/ace, as the delete recheck reads them. */
export function openPrsFrom(branch: string, numbers: number[]) {
  const query = new URLSearchParams({ state: "open", head: `octo:${branch}`, per_page: "10" });
  return { [`repos/octo/ace/pulls?${query}`]: [{ body: numbers.map((number) => ({ number })) }] };
}
