import type { ForgePrList } from "@ace/protocol";
import { expect, test } from "vitest";
import { nextReadyRead, readinessQueries } from "./pr-readiness.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
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
  expect(nextReadyRead([], [], 3)).toEqual({ query: 0, page: 1 });
  expect(nextReadyRead([{ query: 0, page: 1 }], [page(2)], 3)).toEqual({ query: 0, page: 2 });
  expect(nextReadyRead([{ query: 0, page: 1 }], [page()], 3)).toEqual({ query: 1, page: 1 });
  expect(nextReadyRead([{ query: 2, page: 1 }], [page()], 3)).toBeUndefined();
  // Nothing is asked for while the last read is still on its way.
  expect(nextReadyRead([{ query: 0, page: 1 }], [undefined], 3)).toBeUndefined();
});
