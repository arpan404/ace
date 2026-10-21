import { ForgeIssueSearch, type ForgeIssueRow } from "@ace/protocol";
import type { RowGroup } from "./pulls-model.ts";

/** What the Issues list shows, as its address keeps it (`/issues?state=closed&…`). */
export interface IssuesSearch {
  project?: string | undefined;
  who?: "all" | "assigned" | "created" | undefined;
  state?: "open" | "closed" | undefined;
  sort?: IssuesSort | undefined;
  author?: string | undefined;
  labels?: string[] | undefined;
  q?: string | undefined;
  /** The open issue, beside the list. */
  issue?: number | undefined;
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
