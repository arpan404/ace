import type {
  ForgeBrowserOperation,
  ForgeBrowserResult,
  ForgeIssueDetail,
  ForgeIssueRow,
  ForgePrRow,
  ForgeRepository,
} from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";
import { issueRow, prRow } from "./forge-list-rows.ts";

/** The account the fake's `gh` is signed in as: what GitHub resolves `@me` to. */
const viewer = "you";
const pageSize = 25;

type Op<K extends ForgeBrowserOperation["op"]> = Extract<ForgeBrowserOperation, { op: K }>;

/** The repository a project's reads name when they name none, as the daemon resolves it. */
export function projectRepository(op: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
}): ForgeRepository {
  return (
    op.repository ?? { forge: "github", host: "github.com", owner: "acme", name: op.workspaceId }
  );
}

const sameRepository = (a: ForgeRepository, b: ForgeRepository) =>
  `${a.host}/${a.owner}/${a.name}`.toLowerCase() === `${b.host}/${b.owner}/${b.name}`.toLowerCase();
const login = (value: string) => (value === "@me" ? viewer : value);
const matches = (title: string, search: string) =>
  search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => title.toLowerCase().includes(word));
const newestFirst = <T extends { updatedAt: string }>(a: T, b: T) =>
  b.updatedAt.localeCompare(a.updatedAt);
const page = <T>(items: readonly T[], at: number) => ({
  items: items.slice((at - 1) * pageSize, at * pageSize),
  total: items.length,
  ...(at * pageSize < items.length ? { nextPage: at + 1 } : {}),
});

const reviewMatches = (row: ForgePrRow, review: Op<"forge.pr.list">["query"]["review"]) =>
  review === "any" ||
  (review === "approved" && row.reviewDecision === "APPROVED") ||
  (review === "changes_requested" && row.reviewDecision === "CHANGES_REQUESTED") ||
  (review === "required" && row.reviewDecision === "REVIEW_REQUIRED") ||
  (review === "none" && !row.reviewDecision);

/**
 * A pull request search answered from the catalog's whole pull requests, as GitHub's search
 * would: by state, words in the title, author, reviewer, assignee, labels, review decision and
 * checks, newest activity first, with the count of each state for the same search.
 */
export function catalogPrList(
  op: Op<"forge.pr.list">,
  fixtures: readonly PullRequestFixture[],
): ForgeBrowserResult | undefined {
  if (!fixtures.length) return undefined;
  const repository = projectRepository(op);
  const { query } = op;
  const found = fixtures
    .filter((fixture) => sameRepository(fixture.detail.status.ref.repository, repository))
    .map(prRow)
    .filter(
      (row) =>
        matches(row.title, query.search) &&
        (!query.author || row.author === login(query.author)) &&
        (!query.reviewer || (row.reviewers ?? []).includes(login(query.reviewer))) &&
        (!query.assignee || (row.assignees ?? []).includes(login(query.assignee))) &&
        (query.ci === "any" || row.ci === query.ci) &&
        reviewMatches(row, query.review) &&
        query.labels.every((label) => row.labels.includes(label)),
    )
    .toSorted(newestFirst);
  const inState = (state: ForgePrRow["state"]) => found.filter((row) => row.state === state);
  const listed =
    query.state === "all"
      ? found
      : query.state === "active"
        ? found.filter((row) => row.state === "open" || row.state === "draft")
        : inState(query.state);
  return {
    resource: "prList",
    value: {
      repository,
      viewer,
      ...page(listed, query.page),
      counts: {
        open: inState("open").length,
        draft: inState("draft").length,
        closed: inState("closed").length,
        merged: inState("merged").length,
      },
      incomplete: false,
      truncated: false,
    },
  };
}

/** The number a timeline read's key names, for counting an issue's comments. */
function timelineNumber(key: string): number | undefined {
  try {
    const op: unknown = JSON.parse(key);
    if (typeof op !== "object" || op === null || !("number" in op)) return undefined;
    return typeof op.number === "number" ? op.number : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An issue search answered from the issues the fake knows in full (seeded or created through
 * `forge.issue.write`), so a new or closed issue moves between lists as on GitHub.
 */
export function catalogIssueList(
  op: Op<"forge.issue.list">,
  reads: ReadonlyMap<string, ForgeBrowserResult>,
): ForgeBrowserResult | undefined {
  const repository = projectRepository(op);
  const { query } = op;
  const byNumber = new Map<number, ForgeIssueDetail>();
  const comments = new Map<number, number>();
  for (const [key, value] of reads) {
    if (value.resource === "issueDetail" && sameRepository(value.value.ref.repository, repository))
      byNumber.set(value.value.ref.number, value.value);
    const number = value.resource === "issueTimeline" ? timelineNumber(key) : undefined;
    if (value.resource === "issueTimeline" && number !== undefined)
      comments.set(number, value.events.filter((event) => event.kind === "issue_comment").length);
  }
  if (!byNumber.size) return undefined;
  const found: ForgeIssueRow[] = [...byNumber.values()]
    .filter(
      (issue) =>
        matches(issue.title, query.search) &&
        (!query.author || issue.author === login(query.author)) &&
        (!query.assignee || issue.assignees.includes(login(query.assignee))) &&
        query.labels.every((label) => issue.labels.includes(label)),
    )
    .map((issue) => issueRow(issue, comments.get(issue.ref.number) ?? 0))
    .toSorted(newestFirst);
  const inState = (state: ForgeIssueRow["state"]) => found.filter((row) => row.state === state);
  return {
    resource: "issueList",
    value: {
      repository,
      viewer,
      ...page(inState(query.state), query.page),
      counts: { open: inState("open").length, closed: inState("closed").length },
      canCreate: true,
      unavailableReason: "",
      incomplete: false,
      truncated: false,
    },
  };
}
