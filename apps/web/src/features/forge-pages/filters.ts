import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeIssueList,
  type ForgePrList,
} from "@ace/protocol";
import { z } from "zod";

/** Which list the view shows: its two tabs. */
export type ForgeKind = "pulls" | "issues";

export const prStates = ["open", "draft", "merged", "closed"] as const;
export type PrState = (typeof prStates)[number];
export const prPeople = ["all", "mine", "review"] as const;
export type PrPeople = (typeof prPeople)[number];

export const issueStates = ["open", "closed"] as const;
export type IssueState = (typeof issueStates)[number];
export const issuePeople = ["all", "mine", "assigned"] as const;
export type IssuePeople = (typeof issuePeople)[number];

/** What the person last chose, kept on this device: the project and each list's filters. */
export const ForgeFilters = z.object({
  project: z.string().min(1).max(512).optional().catch(undefined),
  prState: z.enum(prStates).catch("open"),
  prPeople: z.enum(prPeople).catch("all"),
  issueState: z.enum(issueStates).catch("open"),
  issuePeople: z.enum(issuePeople).catch("all"),
});
export type ForgeFilters = z.infer<typeof ForgeFilters>;
export const defaultFilters: ForgeFilters = ForgeFilters.parse({});

export const prStateLabels: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};
export const prPeopleLabels: Record<PrPeople, string> = {
  all: "Everyone",
  mine: "Created by me",
  review: "Review requested",
};
export const issueStateLabels: Record<IssueState, string> = { open: "Open", closed: "Closed" };
export const issuePeopleLabels: Record<IssuePeople, string> = {
  all: "Everyone",
  mine: "Created by me",
  assigned: "Assigned to me",
};

/** The daemon's PR search for these filters; `@me` is resolved by GitHub, never read by ace. */
export function prQuery(
  filters: Pick<ForgeFilters, "prState" | "prPeople">,
  search: string,
  page: number,
): ForgePrSearch {
  return ForgePrSearch.parse({
    state: filters.prState,
    search: search.trim(),
    author: filters.prPeople === "mine" ? "@me" : "",
    reviewer: filters.prPeople === "review" ? "@me" : "",
    page,
  });
}

export function issueQuery(
  filters: Pick<ForgeFilters, "issueState" | "issuePeople">,
  search: string,
  page: number,
): ForgeIssueSearch {
  return ForgeIssueSearch.parse({
    state: filters.issueState,
    search: search.trim(),
    author: filters.issuePeople === "mine" ? "@me" : "",
    assignee: filters.issuePeople === "assigned" ? "@me" : "",
    page,
  });
}

/** "Open 12": a state's menu label with the count GitHub reported for the current search. */
export function prStateOptions(counts: ForgePrList["counts"] | undefined) {
  return prStates.map((state) => ({
    value: state,
    label: counts ? `${prStateLabels[state]} ${counts[state]}` : prStateLabels[state],
  }));
}

export function issueStateOptions(counts: ForgeIssueList["counts"] | undefined) {
  return issueStates.map((state) => ({
    value: state,
    label: counts ? `${issueStateLabels[state]} ${counts[state]}` : issueStateLabels[state],
  }));
}

/** The project a list reads: the one in the address, else the last chosen if it still exists. */
export function listProject(
  routed: string | undefined,
  chosen: string | undefined,
  projects: readonly string[],
): string | undefined {
  if (routed) return routed;
  if (chosen && projects.includes(chosen)) return chosen;
  return projects[0];
}
