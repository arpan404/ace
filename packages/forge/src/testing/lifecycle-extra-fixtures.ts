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
  } = {},
) {
  const { closing: issues = [], manual = [], ...rest } = overrides;
  return {
    ...lifecycleRecord(rest.state ? { state: rest.state } : {}),
    milestone: null,
    locked: false,
    activeLockReason: null,
    headRefName: "feature/fix",
    headRef: { name: "feature/fix" },
    isCrossRepository: false,
    viewerCanDeleteHeadRef: true,
    closingIssuesReferences: closing(issues),
    manualClosingIssues: closing(manual),
    ...rest,
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
      at === null ? { status: 404, body: { message: "Not Found" } } : { body: { object: { sha: at } } },
    ],
  };
}
