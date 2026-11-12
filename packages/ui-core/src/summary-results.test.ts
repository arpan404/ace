import { LinkedPullRequest, TurnDigest } from "@ace/protocol";
import { expect, test } from "vitest";
import type { z } from "zod";
import type { CheckRun } from "./check-runs.ts";
import {
  checkWords,
  filesChangedWords,
  linkedChecks,
  otherCommandFailures,
  summaryPrLine,
  summaryPrRows,
  todoStatusWords,
} from "./summary-results.ts";

const digest = (patch: Partial<z.input<typeof TurnDigest>> = {}): TurnDigest =>
  TurnDigest.parse({
    toolCounts: {},
    files: [],
    commands: [],
    commandsRun: 0,
    commandsFailed: 0,
    approvalsAsked: 0,
    approvalsAnswered: 0,
    approvalsAutoReviewed: 0,
    approvalsPending: 0,
    subagentsStarted: 0,
    subagentsFinished: 0,
    inputTokens: null,
    outputTokens: null,
    errors: 0,
    truncated: false,
    ...patch,
  });

const pr = (number: number, state: LinkedPullRequest["state"]): LinkedPullRequest =>
  LinkedPullRequest.parse({
    repo: { forge: "github", host: "github.com", owner: "acme", name: "app" },
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state,
    title: `PR ${number}`,
    updatedAt: 1,
  });

const file = (path: string) => ({ path, added: 1, removed: 0 });

const linked = (checks?: LinkedPullRequest["checks"]) => ({ ...pr(5, "open"), checks });

const check = (patch: Partial<CheckRun>): CheckRun => ({
  kind: "test",
  itemId: "i1",
  command: "bun run test",
  failed: false,
  exitCode: 0,
  ...patch,
});

test("a pull request's line gives its number, state and, once known, its checks", () => {
  expect(summaryPrLine(pr(12, "open"))).toBe("#12 · In review");
  expect(summaryPrLine(pr(12, "draft"), "failure")).toBe("#12 · Draft · Checks failed");
  expect(summaryPrLine(pr(12, "merged"), "unknown")).toBe("#12 · Merged");
});

test("closed pull requests fold into one line until the person opens them", () => {
  const prs = [pr(3, "open"), pr(2, "closed"), pr(1, "closed")];
  expect(summaryPrRows(prs, false)).toEqual({
    rows: [prs[0]],
    fold: "2 earlier pull requests, closed",
  });
  expect(summaryPrRows(prs, true)).toEqual({ rows: prs, fold: "Hide closed pull requests" });
  expect(summaryPrRows([pr(3, "merged")], false).fold).toBeUndefined();
});

test("a check reads as its kind and outcome, with the exit code only when it failed", () => {
  expect(checkWords(check({}), "passed")).toBe("Tests passed");
  expect(checkWords(check({ kind: "typecheck", failed: true, exitCode: 2 }), "failed")).toBe(
    "Typecheck failed · exit 2",
  );
  expect(checkWords(check({ failed: true, exitCode: null }), "failed")).toBe("Tests failed");
  expect(checkWords(check({ exitCode: undefined }), "running")).toBe("Tests running");
});

test("changed files say 64+ once the digest stopped counting", () => {
  expect(filesChangedWords(digest({ files: [file("a")] }))).toBe("1 file changed");
  const many = Array.from({ length: 64 }, (_, index) => file(`f${index}`));
  expect(filesChangedWords(digest({ files: many, truncated: true }))).toBe("64+ files changed");
  expect(filesChangedWords(digest({ files: many }))).toBe("64 files changed");
});

test("failed commands outside a check are counted once, never the failed checks again", () => {
  const failedCheck = check({ failed: true, exitCode: 1 });
  expect(otherCommandFailures(digest({ commandsRun: 5, commandsFailed: 3 }), [failedCheck])).toBe(
    2,
  );
  expect(otherCommandFailures(digest({ commandsRun: 5, commandsFailed: 1 }), [failedCheck])).toBe(
    0,
  );
  expect(otherCommandFailures(undefined, [])).toBe(0);
});

test("each to-do status has words for those who can't see the box", () => {
  expect(
    (["completed", "in_progress", "cancelled", "pending"] as const).map(todoStatusWords),
  ).toEqual(["done", "in progress", "cancelled", "to do"]);
});

test("a linked pull request's own checks roll-up reads as the forge's checks state", () => {
  expect(summaryPrLine(linked("passed"), linkedChecks(linked("passed")))).toBe(
    "#5 · In review · Checks passed",
  );
  expect(linkedChecks(linked("pending"))).toBe("pending");
  expect(linkedChecks(linked("failed"))).toBe("failure");
  expect(linkedChecks(linked())).toBeUndefined();
});
