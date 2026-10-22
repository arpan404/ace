import { ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import { expect, test } from "vitest";
import { groupIssues, issueQuery, issueSourceText, prQuery, sortPrs } from "./forge-lists.ts";

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

const issue = (number: number, patch: Partial<ForgeIssueRow>): ForgeIssueRow =>
  ForgeIssueRow.parse({
    ref: { repository, number },
    title: `Issue ${number}`,
    url: `https://github.com/acme/ace/issues/${number}`,
    author: "dev",
    state: "open",
    labels: [],
    assignees: [],
    milestone: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    ...patch,
  });

test("issues group as assigned to you, then opened by you, then the rest; without a viewer they are one group", () => {
  const rows = [
    issue(1, {}),
    issue(2, { author: "Me" }),
    issue(3, { author: "me", assignees: ["ME"] }),
  ];
  expect(
    groupIssues(rows, "me").map((group) => [group.id, group.rows.map((r) => r.ref.number)]),
  ).toEqual([
    ["assigned", [3]],
    ["created", [2]],
    ["others", [1]],
  ]);
  expect(groupIssues(rows, undefined).map((group) => group.id)).toEqual(["all"]);
});

test("Assigned and Created ask GitHub for the viewer's issues", () => {
  expect(issueQuery({ who: "assigned" }, 1)).toMatchObject({ assignee: "@me", author: "" });
  expect(issueQuery({ who: "created", state: "closed", sort: "comments" }, 3)).toMatchObject({
    author: "@me",
    state: "closed",
    sort: "comments",
    page: 3,
  });
});

test("a thread started from an issue opens with what to work on, its link and its body", () => {
  expect(
    issueSourceText({ ...issue(12, { title: "Crash on start" }), body: "Steps to reproduce" }),
  ).toBe(
    "Work on GitHub issue #12: Crash on start\nhttps://github.com/acme/ace/issues/12\n\nSteps to reproduce",
  );
});
