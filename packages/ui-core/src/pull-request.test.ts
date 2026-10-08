import { ForgePrStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { parsePrReference, parseReviewers, prOverview } from "./pull-request.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const check = (name: string, status: "success" | "failure" | "pending") => ({
  id: name,
  name,
  status,
  conclusion: status === "pending" ? null : status,
  completedAt: null,
  jobId: null,
  url: `https://github.com/acme/api/actions/runs/${name}`,
});
const status = (patch: Partial<ForgePrStatus> = {}) =>
  ForgePrStatus.parse({
    ref: { repository, number: 42 },
    title: "Retry the replay cursor",
    url: "https://github.com/acme/api/pull/42",
    headSha: "c".repeat(40),
    state: "open",
    mergeability: "mergeable",
    ci: "success",
    checks: [check("lint", "success"), check("test", "success")],
    comments: [],
    reviewThreads: [],
    raw: {},
    ...patch,
  });

test("a passing, clean PR can merge now and has nothing for auto-merge to wait on", () => {
  const view = prOverview(status(), "main");
  expect(view.ci).toEqual({ tone: "success", text: "2 checks passed" });
  expect(view.merge).toEqual({ tone: "clean", text: "No conflicts with main" });
  expect(view.mergeBlocked).toBeUndefined();
  expect(view.autoMergeBlocked).toMatch(/merge it now/);
});

test("failing checks block merging, are counted, and list first", () => {
  const view = prOverview(
    status({
      ci: "failure",
      checks: [check("lint", "success"), check("test (pdf)", "failure"), check("e2e", "pending")],
    }),
    "main",
  );
  expect(view.ci).toEqual({ tone: "failure", text: "1 of 3 checks failed" });
  expect(view.checks.map((each) => each.name)).toEqual(["test (pdf)", "e2e", "lint"]);
  expect(view.mergeBlocked).toBe("Fix the failing checks first");
  expect(view.autoMergeBlocked).toBe("Fix the failing checks first");
});

test("conflicts block merging and name the base branch", () => {
  const view = prOverview(status({ mergeability: "conflicting" }), "develop");
  expect(view.merge).toEqual({ tone: "conflict", text: "Conflicts with develop" });
  expect(view.mergeBlocked).toBe("Resolve the conflicts with develop first");
});

test("running checks leave Merge open and let auto-merge wait for them", () => {
  const view = prOverview(
    status({ ci: "pending", checks: [check("lint", "success"), check("test", "pending")] }),
    "main",
  );
  expect(view.ci).toEqual({ tone: "pending", text: "Checks running · 1 of 2 done" });
  expect(view.mergeBlocked).toBeUndefined();
  expect(view.autoMergeBlocked).toBeUndefined();
});

test("a draft, merged or closed PR can't merge, and says why", () => {
  expect(prOverview(status({ state: "draft" }), "main").mergeBlocked).toMatch(/ready for review/);
  expect(prOverview(status({ state: "merged" }), "main").mergeBlocked).toBe("Already merged");
  expect(prOverview(status({ state: "closed" }), "main").autoMergeBlocked).toMatch(/closed/);
});

const thread = (id: string, resolved: boolean) => ({
  id,
  resolved,
  outdated: false,
  file: "src/a.ts",
  line: 1,
  comments: [],
});

test("only unresolved review threads are counted", () => {
  expect(
    prOverview(
      status({ reviewThreads: [thread("a", false), thread("b", true), thread("c", false)] }),
      "main",
    ).unresolved,
  ).toBe(2);
});

test("a PR is named by its number, #number or its address in this repository", () => {
  expect(parsePrReference("42", repository)).toEqual({ number: 42 });
  expect(parsePrReference(" #7 ", repository)).toEqual({ number: 7 });
  expect(parsePrReference("https://github.com/acme/api/pull/188/files", repository)).toEqual({
    number: 188,
  });
  expect(parsePrReference("https://github.com/acme/api/issues/9", repository)).toEqual({
    error: "That address isn't a pull request",
  });
  expect(parsePrReference("https://github.com/Acme/API/pull/188/", repository)).toEqual({
    number: 188,
  });
  expect(parsePrReference("https://github.com/other/api/pull/3", repository)).toEqual({
    error: "That PR isn't in acme/api",
  });
  expect(parsePrReference("fix the build", repository)).toMatchObject({ error: /PR number/ });
  expect(parsePrReference("#0", repository)).toMatchObject({ error: /start at 1/ });
});

test("reviewers are GitHub usernames, with or without @, separated by commas or spaces", () => {
  expect(parseReviewers("@mira, sam  mira")).toEqual({ reviewers: ["mira", "sam"] });
  expect(parseReviewers("")).toEqual({ reviewers: [] });
  expect(parseReviewers("mira, acme/core")).toEqual({
    error: "“acme/core” isn't a GitHub username",
  });
});
