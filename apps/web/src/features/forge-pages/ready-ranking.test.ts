import { ForgePrRow, type ForgePrList } from "@ace/protocol";
import { expect, test } from "vitest";
import { nextStep, rankByReadiness, readinessQueries } from "./ready-ranking.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const row = (number: number, patch: Partial<ForgePrRow> = {}): ForgePrRow =>
  ForgePrRow.parse({
    ref: { repository, number },
    title: `PR ${number}`,
    url: `https://github.com/acme/ace/pull/${number}`,
    author: "dev",
    state: "open",
    labels: [],
    updatedAt: `2026-10-${String(10 + number).padStart(2, "0")}T00:00:00Z`,
    ci: "success",
    reviewDecision: "APPROVED",
    ...patch,
  });
const ranked = (rows: ForgePrRow[]) =>
  Object.fromEntries(
    rankByReadiness(rows).map((group) => [group.label, group.rows.map((r) => r.ref.number)]),
  );

test("pull requests are ranked readiest first, mergeable then newest first within each tier", () => {
  expect(
    ranked([
      row(1),
      row(2, { ci: "failure" }),
      row(3, { conflicting: true }),
      row(4, { reviewDecision: "REVIEW_REQUIRED" }),
      row(5, { reviewDecision: null, ci: "none" }),
      row(6, { state: "draft" }),
      row(7, { ci: "pending" }),
      row(8, { reviewDecision: "CHANGES_REQUESTED" }),
    ]),
  ).toEqual({
    // A conflict can't be searched: it only moves #3 to the end of its tier.
    Ready: [5, 1, 3],
    "Waiting on checks": [7],
    "Waiting on review": [4],
    "Needs changes": [8, 2],
    Drafts: [6],
  });
});

test("a pull request found by two searches is listed once", () => {
  expect(ranked([row(1), row(2), row(1)])).toEqual({ Ready: [2, 1] });
});

test("open pull requests are asked of GitHub readiest first, then the rest, then drafts", () => {
  const queries = readinessQueries({ who: "authored", labels: ["bug"] });
  expect(queries.map((query) => [query.state, query.review, query.ci])).toEqual([
    ["open", "approved", "success"],
    ["open", "approved", "pending"],
    ["open", "required", "any"],
    ["open", "changes_requested", "any"],
    ["open", "any", "failure"],
    ["open", "any", "any"],
    ["draft", "any", "any"],
  ]);
  // The list's own filters narrow every tier.
  expect(queries.every((query) => query.author === "@me" && query.labels[0] === "bug")).toBe(true);
});

test("a review, checks or drafts filter, or another state, reads one plain search", () => {
  expect(readinessQueries({ review: "approved" })).toHaveLength(1);
  expect(readinessQueries({ checks: "failing" })).toHaveLength(1);
  expect(readinessQueries({ state: "merged" })).toHaveLength(1);
});

const page = (nextPage?: number): ForgePrList => ({
  repository,
  items: [],
  total: 0,
  counts: { open: 0, draft: 0, closed: 0, merged: 0 },
  incomplete: false,
  truncated: false,
  ...(nextPage ? { nextPage } : {}),
});

test("reading continues the current search's pages, then moves to the next search, then stops", () => {
  expect(nextStep([], [], 3)).toEqual({ query: 0, page: 1 });
  expect(nextStep([{ query: 0, page: 1 }], [page(2)], 3)).toEqual({ query: 0, page: 2 });
  expect(nextStep([{ query: 0, page: 1 }], [page()], 3)).toEqual({ query: 1, page: 1 });
  expect(nextStep([{ query: 2, page: 1 }], [page()], 3)).toBeUndefined();
  // Nothing is asked for while the last read is still on its way.
  expect(nextStep([{ query: 0, page: 1 }], [undefined], 3)).toBeUndefined();
});
