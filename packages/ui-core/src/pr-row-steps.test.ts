import { ForgePrRow, type ThreadListEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import { groupBySteps, linkedWork, rowStep, waitingWord, workKey } from "./pr-row-steps.ts";

const repository = { forge: "github", host: "github.com", owner: "Acme", name: "Ace" } as const;
const row = (number: number, patch: Partial<ForgePrRow> = {}): ForgePrRow =>
  ForgePrRow.parse({
    ref: { repository, number },
    title: `PR ${number}`,
    url: `https://github.com/acme/ace/pull/${number}`,
    author: "someone",
    state: "open",
    labels: [],
    updatedAt: `2026-10-${String(10 + number).padStart(2, "0")}T00:00:00Z`,
    ci: "success",
    reviewDecision: "APPROVED",
    ...patch,
  });

test("open pull requests group as needs you, ready to merge, waiting and drafts, leaving empty groups out", () => {
  const rows = [
    row(1, { state: "draft" }),
    row(2, { reviewers: ["me"] }),
    row(3),
    row(4, { ci: "pending" }),
  ];
  const groups = groupBySteps(rows, (pr) => rowStep(pr, "me", undefined, []).step);
  expect(groups.map((group) => [group.id, group.rows.map((pr) => pr.ref.number)])).toEqual([
    ["you", [2]],
    ["merge", [3]],
    ["wait", [4]],
    ["drafts", [1]],
  ]);
});

test("in Needs you a thread waiting on the person comes before a review, whatever its age", () => {
  const rows = [row(9, { reviewers: ["me"] }), row(1)];
  const thread = { id: "t1", title: "Fix it", needsYou: true };
  const linked = new Map([[workKey(repository, 1), thread]]);
  const groups = groupBySteps(
    rows,
    (pr) => rowStep(pr, "me", linked.get(workKey(pr.ref.repository, pr.ref.number)), []).step,
  );
  expect(groups[0]?.rows.map((pr) => pr.ref.number)).toEqual([1, 9]);
});

test("a waiting row says checks are running before it says it waits on review", () => {
  expect(waitingWord(row(1, { ci: "pending", reviewDecision: "REVIEW_REQUIRED" }), undefined)).toBe(
    "Checks running",
  );
  expect(waitingWord(row(1, { reviewDecision: "REVIEW_REQUIRED" }), undefined)).toBe(
    "Waiting on review",
  );
  expect(waitingWord(row(1), "running")).toBe("Checks running");
});

const entry = (
  id: string,
  patch: { archivedAt?: number; state?: string; prs?: number[]; issues?: number[] },
): ThreadListEntry =>
  ({
    id,
    title: `Thread ${id}`,
    archivedAt: patch.archivedAt,
    status: { state: patch.state ?? "working" },
    details: {
      linkedPrs: (patch.prs ?? []).map((number) => ({
        repo: { ...repository, owner: "acme", name: "ace" },
        number,
      })),
      linkedIssues: (patch.issues ?? []).map((number) => ({ repository, number })),
    },
  }) as unknown as ThreadListEntry;

test("linked work names the first listed thread per pull request or issue, skips archived ones, and says when it needs you", () => {
  const threads = [
    entry("old", { archivedAt: 1, prs: [5] }),
    entry("new", { state: "needs_you", prs: [5], issues: [7] }),
    entry("other", { prs: [5, 6] }),
  ];
  const reader = {
    ids: threads.map((thread) => thread.id),
    thread: (id: string) => threads.find((t) => t.id === id),
  };
  const { pulls, issues } = linkedWork(reader);
  expect(pulls.get(workKey(repository, 5))).toEqual({
    id: "new",
    title: "Thread new",
    needsYou: true,
  });
  expect(pulls.get(workKey(repository, 6))?.id).toBe("other");
  expect(issues.get(workKey({ owner: "ACME", name: "ace" }, 7))?.id).toBe("new");
});
