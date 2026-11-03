import { ForgePrRow } from "@ace/protocol";
import { expect, test } from "vitest";
import { rowStep, type LinkedThread } from "./pr-row-steps.ts";
import { groupByWork, prNextAction, prStatusWords } from "./pr-work-groups.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const row = (number: number, patch: Partial<ForgePrRow> = {}): ForgePrRow =>
  ForgePrRow.parse({
    ref: { repository, number },
    title: `PR ${number}`,
    url: `https://github.com/acme/ace/pull/${number}`,
    author: "me",
    state: "open",
    labels: [],
    updatedAt: `2026-10-${String(10 + number).padStart(2, "0")}T00:00:00Z`,
    ci: "success",
    reviewDecision: "APPROVED",
    baseBranch: "main",
    ...patch,
  });
const working: LinkedThread = { id: "t", title: "Fix it", needsYou: false, working: true };
const asking: LinkedThread = { id: "t", title: "Fix it", needsYou: true, working: false };

function grouped(rows: ForgePrRow[], threads: Record<number, LinkedThread> = {}) {
  const threadOf = (pr: ForgePrRow) => threads[pr.ref.number];
  const groups = groupByWork(rows, (pr) => rowStep(pr, "me", threadOf(pr), []).step, threadOf);
  return Object.fromEntries(
    groups.map((group) => [group.label, group.rows.map((pr) => pr.ref.number)]),
  );
}

test("open pull requests group as needs you, agents working, waiting on others and ready to merge", () => {
  expect(
    grouped(
      [
        row(1, { author: "sam", reviewers: ["me"] }),
        row(2, { ci: "failure" }),
        row(3),
        row(4, { author: "sam", reviewDecision: "REVIEW_REQUIRED", reviewers: ["dana"] }),
        row(5, { state: "draft" }),
      ],
      { 2: working },
    ),
  ).toEqual({
    "Needs you": [1],
    "Agents working": [2],
    "Waiting on others": [5, 4],
    "Ready to merge": [3],
  });
});

test("a pull request stays with its agent while it works, even once it could merge", () => {
  expect(grouped([row(1)], { 1: working })).toEqual({ "Agents working": [1] });
  expect(prNextAction("merge", working)).toBe("Open thread");
});

test("an agent's question and a review asked of you come first, whatever their age", () => {
  expect(
    grouped([row(9, { ci: "failure" }), row(1, { author: "sam", reviewers: ["me"] }), row(2)], {
      2: asking,
    })["Needs you"],
  ).toEqual([2, 1, 9]);
});

function words(pr: ForgePrRow, thread?: LinkedThread) {
  const { step, local } = rowStep(pr, "me", thread, []);
  return prStatusWords(pr, step, local, thread);
}

test("each row says its state in words, in the tone of its status", () => {
  expect(words(row(1, { ci: "failure" }))).toEqual({ words: "Checks failing", tone: "failed" });
  expect(words(row(1, { author: "sam", reviewers: ["me"] }))).toEqual({
    words: "Your review",
    tone: undefined,
  });
  expect(words(row(1, { behind: true }))).toEqual({ words: "Behind main", tone: "needs-you" });
  expect(words(row(1))).toEqual({ words: "Ready to merge", tone: "done" });
  expect(words(row(1, { ci: "failure" }), working)).toEqual({
    words: "Agent working",
    tone: "working",
  });
  expect(
    words(row(1, { author: "sam", reviewDecision: "REVIEW_REQUIRED", reviewers: ["dana", "lee"] })),
  ).toEqual({ words: "Waiting on dana +1", tone: "idle" });
  expect(words(row(1, { state: "merged" }))).toEqual({ words: "Merged", tone: "waiting" });
});
