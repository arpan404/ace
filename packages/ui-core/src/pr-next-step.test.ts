import { expect, test } from "vitest";
import { WorkspaceId, type VerifyRun } from "@ace/protocol";
import { localCheckOf, prNextStep, type PrNextStepInput } from "./pr-next-step.ts";

const open = (row: Partial<PrNextStepInput["row"]> = {}, rest: Partial<PrNextStepInput> = {}) =>
  prNextStep({
    row: {
      state: "open",
      author: "mira",
      ci: "success",
      reviewDecision: "APPROVED",
      reviewers: [],
      conflicting: false,
      behind: false,
      ...row,
    },
    viewer: "mira",
    linked: false,
    linkedNeedsYou: false,
    local: undefined,
    ...rest,
  });

test("an agent waiting on the person comes before everything else", () => {
  expect(open({ conflicting: true, ci: "failure" }, { linked: true, linkedNeedsYou: true })).toBe(
    "answer",
  );
});

test("a review requested from the viewer on someone else's PR asks for their review", () => {
  expect(open({ author: "sam", reviewers: ["Mira"] })).toBe("review");
  // Not on their own PR.
  expect(open({ reviewers: ["mira"] })).toBe("merge");
});

test("the viewer's own PR needs, in order: conflicts resolved, checks fixed, review addressed, branch updated", () => {
  const all = {
    conflicting: true,
    ci: "failure" as const,
    reviewDecision: "CHANGES_REQUESTED" as const,
    behind: true,
  };
  expect(open(all)).toBe("resolve");
  expect(open({ ...all, conflicting: false })).toBe("fix");
  expect(open({ ...all, conflicting: false, ci: "success" })).toBe("address");
  expect(open({ behind: true })).toBe("update");
});

test("a PR ace made is the viewer's to fix even when someone else opened it", () => {
  expect(open({ author: "sam", ci: "failure" }, { linked: true })).toBe("fix");
  expect(open({ author: "sam", ci: "failure" })).toBe("wait");
});

test("a failing local check counts as failing checks, and a running one holds a merge", () => {
  expect(open({ ci: "none" }, { local: "failed" })).toBe("fix");
  expect(open({ ci: "none" }, { local: "running" })).toBe("wait");
  expect(open({ ci: "none" }, { local: "passed" })).toBe("merge");
});

test("an approved PR, or one needing no review, with passing or no checks is ready to merge", () => {
  expect(open({ author: "sam" })).toBe("merge");
  expect(open({ author: "sam", reviewDecision: null, ci: "none" })).toBe("merge");
  expect(open({ author: "sam", reviewDecision: "REVIEW_REQUIRED" })).toBe("wait");
  expect(open({ author: "sam", ci: "pending" })).toBe("wait");
});

test("drafts, merged and closed PRs have no step to take", () => {
  expect(open({ state: "draft", ci: "failure" })).toBe("draft");
  expect(open({ state: "merged" })).toBe("none");
  expect(open({ state: "closed", conflicting: true })).toBe("none");
});

const repository = { forge: "github" as const, host: "github.com", owner: "acme", name: "ace" };
const run = (over: Partial<VerifyRun> & { headSha: string; createdAt: number }): VerifyRun => ({
  id: `run-${over.createdAt}`,
  workspaceId: WorkspaceId.parse("w"),
  target: {
    kind: "check",
    pr: { pr: { repository, number: 7 }, headSha: over.headSha },
  },
  state: "passed",
  command: "bun run check",
  steps: [],
  merged: [],
  revision: 1,
  ...over,
});

test("only the newest local check of the PR's current head counts", () => {
  const head = "a".repeat(40);
  const runs = [
    run({ headSha: head, createdAt: 1, state: "failed" }),
    run({ headSha: head, createdAt: 2, state: "passed" }),
    run({ headSha: "b".repeat(40), createdAt: 3, state: "failed" }),
  ];
  const pr = { owner: "Acme", name: "ace", number: 7 };
  expect(localCheckOf(runs, pr, head)).toBe("passed");
  expect(localCheckOf(runs, pr, "b".repeat(40))).toBe("failed");
  expect(localCheckOf(runs, pr, "c".repeat(40))).toBeUndefined();
  expect(localCheckOf([run({ headSha: head, createdAt: 4, state: "queued" })], pr, head)).toBe(
    "running",
  );
});
