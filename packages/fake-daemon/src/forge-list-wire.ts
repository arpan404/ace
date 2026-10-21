import type {
  ForgeBrowserOperation,
  ForgeBrowserResult,
  ForgeIssueDetail,
  ForgeIssueRow,
  ForgePrRow,
  ForgeRepository,
} from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

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

function prRow(fixture: PullRequestFixture): ForgePrRow {
  const { status } = fixture.detail;
  return {
    ref: status.ref,
    title: status.title,
    url: status.url,
    author: fixture.detail.author,
    state: status.state === "unknown" ? "open" : status.state,
    labels: fixture.detail.labels,
    updatedAt: fixture.detail.updatedAt ?? new Date(0).toISOString(),
    commentCount: status.comments.length,
    ci: status.ci,
  };
}

/**
 * A pull request search answered from the catalog's whole pull requests, as GitHub's search
 * would: by state, words in the title, author and requested reviewer, newest activity first,
 * with the count of each state for the same search.
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
    .filter(
      (fixture) =>
        matches(fixture.detail.status.title, query.search) &&
        (!query.author || fixture.detail.author === login(query.author)) &&
        (!query.reviewer || fixture.detail.reviewers.includes(login(query.reviewer))) &&
        (query.ci === "any" || fixture.detail.status.ci === "failure"),
    )
    .map(prRow)
    .toSorted(newestFirst);
  const inState = (state: ForgePrRow["state"]) => found.filter((row) => row.state === state);
  const listed =
    query.state === "active"
      ? found.filter((row) => row.state === "open" || row.state === "draft")
      : inState(query.state);
  return {
    resource: "prList",
    value: {
      repository,
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

function issueRow(detail: ForgeIssueDetail): ForgeIssueRow {
  const {
    body: _body,
    permissions: _p,
    relatedThreads: _r,
    relatedThreadsTruncated: _t,
    ...row
  } = detail;
  return row;
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
  for (const value of reads.values())
    if (value.resource === "issueDetail" && sameRepository(value.value.ref.repository, repository))
      byNumber.set(value.value.ref.number, value.value);
  if (!byNumber.size) return undefined;
  const found = [...byNumber.values()]
    .filter(
      (issue) =>
        matches(issue.title, query.search) &&
        (!query.author || issue.author === login(query.author)) &&
        (!query.assignee || issue.assignees.includes(login(query.assignee))) &&
        query.labels.every((label) => issue.labels.includes(label)),
    )
    .map(issueRow)
    .toSorted(newestFirst);
  const inState = (state: ForgeIssueRow["state"]) => found.filter((row) => row.state === state);
  return {
    resource: "issueList",
    value: {
      repository,
      ...page(inState(query.state), query.page),
      counts: { open: inState("open").length, closed: inState("closed").length },
      canCreate: true,
      unavailableReason: "",
      incomplete: false,
      truncated: false,
    },
  };
}
