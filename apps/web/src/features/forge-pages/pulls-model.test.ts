import { ForgePrRow } from "@ace/protocol";
import { expect, test } from "vitest";
import { prQuery, sortPrs } from "./pulls-model.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const row = (number: number, patch: Partial<ForgePrRow>): ForgePrRow =>
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

test("largest and smallest order by lines changed", () => {
  const rows = [
    row(1, { additions: 5, deletions: 5 }),
    row(2, { additions: 300, deletions: 0 }),
    row(3, { additions: 1, deletions: 0 }),
  ];
  expect(sortPrs(rows, "largest").map((pr) => pr.ref.number)).toEqual([2, 1, 3]);
  expect(sortPrs(rows, "smallest").map((pr) => pr.ref.number)).toEqual([3, 1, 2]);
});

test("open with drafts hidden asks GitHub for non-draft open pull requests; drafts only for drafts", () => {
  expect(prQuery({}, 1).state).toBe("active");
  expect(prQuery({ draft: "hide" }, 1).state).toBe("open");
  expect(prQuery({ draft: "only" }, 1).state).toBe("draft");
  expect(prQuery({ who: "reviewing", checks: "failing", review: "changes" }, 2)).toMatchObject({
    reviewer: "@me",
    ci: "failure",
    review: "changes_requested",
    page: 2,
  });
});
