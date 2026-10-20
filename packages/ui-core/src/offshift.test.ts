import { expect, test } from "vitest";
import type { OffshiftRunCard } from "@ace/protocol/offshift";
import { offshiftSummary, type OffshiftTree } from "./index.ts";

function card(overrides: Partial<OffshiftRunCard> = {}): OffshiftRunCard {
  return {
    id: "login",
    outcome: "Login shows a helpful error",
    outcomeTruncated: false,
    endpoint: "Local change",
    phase: "delivery",
    blocker: null,
    version: 4,
    updatedAt: 1,
    revision: "r1",
    criteria: [
      {
        id: "error",
        description: "Bad password shows an error",
        evidence: [{ kind: "ui", state: "pass", recordedAt: 1 }],
      },
    ],
    criteriaCount: 1,
    pending: [],
    pendingCount: 0,
    ...overrides,
  };
}
const settled: OffshiftTree = { status: { state: "done" }, runningAgents: 0 };

test("a delivered run with current evidence is Done only once the whole tree is", () => {
  expect(offshiftSummary(card(), settled)).toMatchObject({
    word: "Done",
    tone: "done",
    done: true,
  });
  const child = offshiftSummary(card(), { ...settled, runningAgents: 1 });
  expect(child).toMatchObject({ word: "Working", tone: "working", done: false });
  const background = offshiftSummary(card(), {
    status: { state: "waiting", on: "background_task" },
    runningAgents: 0,
  });
  expect(background).toMatchObject({ word: "Waiting", done: false });
  const working = offshiftSummary(card(), {
    status: { state: "working", agents: 1 },
    runningAgents: 0,
  });
  expect(working.word).toBe("Working");
});

test("a request waiting on the person outranks the run: Approve for approvals, else Answer", () => {
  const approval = offshiftSummary(card(), { ...settled, request: "approval" });
  expect(approval).toMatchObject({ word: "Approve", tone: "needs-you" });
  const question = offshiftSummary(card(), {
    status: { state: "needs_you", interactions: 1 },
    runningAgents: 0,
  });
  expect(question).toMatchObject({ word: "Answer", tone: "needs-you" });
  expect(offshiftSummary(card(), { status: { state: "failed" }, runningAgents: 0 }).word).toBe(
    "Failed",
  );
});

test("a blocked run waits and carries its blocker, even while agents work", () => {
  const blocked = offshiftSummary(card({ phase: "implement", blocker: "Need a test account" }), {
    status: { state: "working", agents: 1 },
    runningAgents: 2,
  });
  expect(blocked).toMatchObject({
    word: "Waiting",
    tone: "waiting",
    blocker: "Need a test account",
    phase: "Implement · 2 of 5",
    done: false,
  });
});

test("missing evidence names each criterion and kind and never reads Done", () => {
  const needs = offshiftSummary(
    card({
      phase: "verify",
      criteria: [
        {
          id: "error",
          description: "Bad password shows an error",
          evidence: [
            { kind: "ui", state: "stale", recordedAt: 1 },
            { kind: "automated", state: "fail", recordedAt: 2 },
          ],
        },
      ],
      pending: [
        { criterionId: "error", kind: "ui" },
        { criterionId: "error", kind: "automated" },
        { criterionId: "beyond", kind: "manual" },
      ],
      pendingCount: 5,
    }),
    settled,
  );
  expect(needs.word).toBe("Waiting");
  expect(needs.phase).toBe("Verify · 3 of 5");
  expect(needs.missing.map((item) => `${item.description} · ${item.kind}`)).toEqual([
    "Bad password shows an error · UI check",
    "Bad password shows an error · Automated check",
    "beyond · Manual check",
  ]);
  expect(needs.moreMissing).toBe(2);
  expect(needs.criteria[0]?.evidence).toEqual([
    { kind: "UI check", state: "Out of date", tone: undefined },
    { kind: "Automated check", state: "Failed", tone: "failed" },
  ]);
});

test("a run still in progress on a settled tree waits instead of claiming Working", () => {
  const idle = offshiftSummary(card({ phase: "review" }), settled);
  expect(idle).toMatchObject({ word: "Waiting", phase: "Review · 4 of 5", done: false });
});
