import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeIssueRow,
  type ForgePrRow,
} from "@ace/protocol";

/*
 * The Pull requests and Issues lists, as both clients show them: the searches a list's filters
 * make, its sorts, and its groups by who a row concerns. Pure.
 */

/** What the Pull requests list shows, as its address keeps it (`/pulls?state=merged&…`). */
export interface PullsSearch {
  project?: string | undefined;
  who?: "all" | "authored" | "reviewing" | undefined;
  state?: "open" | "merged" | "closed" | "all" | undefined;
  sort?: PullsSort | undefined;
  draft?: "only" | "hide" | undefined;
  review?: "approved" | "changes" | "required" | "none" | undefined;
  checks?: "passing" | "failing" | undefined;
  author?: string | undefined;
  labels?: string[] | undefined;
  q?: string | undefined;
}
export type PullsSort = "ready" | "updated" | "largest" | "smallest";

export const sortLabels: Record<PullsSort, string> = {
  ready: "Ready to merge",
  updated: "Recently updated",
  largest: "Largest",
  smallest: "Smallest",
};

const reviews = {
  approved: "approved",
  changes: "changes_requested",
  required: "required",
  none: "none",
} as const;

/** The daemon's search for one page of the list; `@me` is GitHub's to resolve. */
export function prQuery(search: PullsSearch, page: number): ForgePrSearch {
  const state = search.state ?? "open";
  return ForgePrSearch.parse({
    state:
      state !== "open"
        ? state
        : search.draft === "only"
          ? "draft"
          : search.draft === "hide"
            ? "open"
            : "active",
    search: search.q?.trim() ?? "",
    author: search.who === "authored" ? "@me" : (search.author ?? ""),
    reviewer: search.who === "reviewing" ? "@me" : "",
    labels: search.labels ?? [],
    review: search.review ? reviews[search.review] : "any",
    ci: search.checks === "passing" ? "success" : search.checks === "failing" ? "failure" : "any",
    page,
  });
}

const size = (row: ForgePrRow) => (row.additions ?? 0) + (row.deletions ?? 0);
const updated = (a: ForgePrRow, b: ForgePrRow) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * The loaded rows by size or newest activity; ties keep the newest first. "Ready to merge"
 * reads the whole repository instead (`useReadyPages`).
 */
export function sortPrs(
  rows: readonly ForgePrRow[],
  sort: Exclude<PullsSort, "ready">,
): ForgePrRow[] {
  if (sort === "largest") return rows.toSorted((a, b) => size(b) - size(a) || updated(a, b));
  if (sort === "smallest") return rows.toSorted((a, b) => size(a) - size(b) || updated(a, b));
  return rows.toSorted(updated);
}

export interface RowGroup<T> {
  id: string;
  label: string;
  rows: T[];
}

/**
 * Yours first, then the ones asking for your review, then the rest. Without knowing who `gh`
 * is signed in as, everything is one group.
 */
export function groupPrs(
  rows: readonly ForgePrRow[],
  viewer: string | undefined,
): RowGroup<ForgePrRow>[] {
  if (!viewer) return [{ id: "all", label: "Pull requests", rows: [...rows] }];
  const me = viewer.toLowerCase();
  const authored = rows.filter((row) => row.author.toLowerCase() === me);
  const reviewing = rows.filter(
    (row) =>
      row.author.toLowerCase() !== me && (row.reviewers ?? []).some((r) => r.toLowerCase() === me),
  );
  const others = rows.filter((row) => !authored.includes(row) && !reviewing.includes(row));
  return [
    { id: "authored", label: "Authored by you", rows: authored },
    { id: "reviewing", label: "Review requested", rows: reviewing },
    { id: "others", label: "Others", rows: others },
  ].filter((group) => group.rows.length > 0);
}

/** What the Issues list shows, as its address keeps it (`/issues?state=closed&…`). */
export interface IssuesSearch {
  project?: string | undefined;
  who?: "all" | "assigned" | "created" | undefined;
  state?: "open" | "closed" | undefined;
  sort?: IssuesSort | undefined;
  author?: string | undefined;
  labels?: string[] | undefined;
  q?: string | undefined;
}
export type IssuesSort = "updated" | "created" | "comments";

export const issueSortLabels: Record<IssuesSort, string> = {
  updated: "Recently updated",
  created: "Newest",
  comments: "Most commented",
};

export function issueQuery(search: IssuesSearch, page: number): ForgeIssueSearch {
  return ForgeIssueSearch.parse({
    state: search.state ?? "open",
    search: search.q?.trim() ?? "",
    author: search.who === "created" ? "@me" : (search.author ?? ""),
    assignee: search.who === "assigned" ? "@me" : "",
    labels: search.labels ?? [],
    sort: search.sort ?? "updated",
    page,
  });
}

/** Assigned to you first, then the ones you opened, then the rest. */
export function groupIssues(
  rows: readonly ForgeIssueRow[],
  viewer: string | undefined,
): RowGroup<ForgeIssueRow>[] {
  if (!viewer) return [{ id: "all", label: "Issues", rows: [...rows] }];
  const me = viewer.toLowerCase();
  const assigned = rows.filter((row) => row.assignees.some((a) => a.toLowerCase() === me));
  const created = rows.filter((row) => !assigned.includes(row) && row.author.toLowerCase() === me);
  const others = rows.filter((row) => !assigned.includes(row) && !created.includes(row));
  return [
    { id: "assigned", label: "Assigned to you", rows: assigned },
    { id: "created", label: "Created by you", rows: created },
    { id: "others", label: "Others", rows: others },
  ].filter((group) => group.rows.length > 0);
}

/** The first message of a thread started from an issue: what to work on, its link and body. */
export function issueSourceText(
  issue: Pick<ForgeIssueRow, "ref" | "title" | "url"> & { body: string },
): string {
  return `Work on GitHub issue #${issue.ref.number}: ${issue.title}\n${issue.url}\n\n${issue.body}`;
}
