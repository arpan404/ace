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
        independent: false,
        evidence: [
          { kind: "ui", state: "pass", recordedAt: 1, by: { provider: "codex", model: null } },
        ],
      },
    ],
    criteriaCount: 1,
    pending: [],
    pendingCount: 0,
    roles: [],
    steps: [],
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

test("a blocked run still says Answer or Failed when the tree asks the person or fails", () => {
  const blocker = card({ phase: "implement", blocker: "Need a test account" });
  const asking = offshiftSummary(blocker, {
    status: { state: "needs_you", interactions: 1 },
    runningAgents: 0,
  });
  expect(asking).toMatchObject({
    word: "Answer",
    tone: "needs-you",
    blocker: "Need a test account",
  });
  const failed = offshiftSummary(blocker, { status: { state: "failed" }, runningAgents: 0 });
  expect(failed).toMatchObject({ word: "Failed", blocker: "Need a test account", done: false });
});

test("missing evidence names each criterion and kind and never reads Done", () => {
  const needs = offshiftSummary(
    card({
      phase: "verify",
      criteria: [
        {
          id: "error",
          description: "Bad password shows an error",
          independent: false,
          evidence: [
            { kind: "ui", state: "stale", recordedAt: 1, by: null },
            {
              kind: "automated",
              state: "fail",
              recordedAt: 2,
              by: { provider: "claude", model: "claude-opus-4-5" },
            },
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
    { kind: "UI check", state: "Out of date", tone: undefined, by: undefined },
    { kind: "Automated check", state: "Failed", tone: "failed", by: "Claude Code · Opus 4.5" },
  ]);
});

test("a run still in progress on a settled tree waits instead of claiming Working", () => {
  const idle = offshiftSummary(card({ phase: "review" }), settled);
  expect(idle).toMatchObject({ word: "Waiting", phase: "Review · 4 of 5", done: false });
});

test("an independent criterion with only the owner's pass reads not independent and stays missing", () => {
  const summary = offshiftSummary(
    card({
      phase: "verify",
      criteria: [
        {
          id: "error",
          description: "Bad password shows an error",
          independent: true,
          evidence: [
            {
              kind: "ui",
              state: "not_independent",
              recordedAt: 1,
              by: { provider: "codex", model: "gpt-5" },
            },
          ],
        },
      ],
      pending: [{ criterionId: "error", kind: "ui", needs: "independent" }],
      pendingCount: 1,
    }),
    settled,
  );
  expect(summary.word).toBe("Waiting");
  expect(summary.criteria[0]).toMatchObject({
    independent: true,
    evidence: [{ state: "Not independent", tone: undefined, by: "Codex · GPT-5" }],
  });
  expect(summary.missing.map((item) => item.kind)).toEqual(["Independent UI check"]);
});

test("roles read as the kind of work and who does it, in words", () => {
  const summary = offshiftSummary(
    card({
      roles: [
        { role: "build", source: "run", provider: "codex", model: "gpt-5" },
        { role: "verify", source: "project", provider: "claude", effort: "high" },
      ],
    }),
    settled,
  );
  expect(summary.roles).toEqual([
    { role: "Build", selection: "Codex · GPT-5" },
    { role: "Verify", selection: "Claude Code · high" },
  ]);
});

test("the current phase's steps read Done, Skipped with its reason, or To do", () => {
  const steps = offshiftSummary(
    card({
      phase: "plan",
      steps: [
        { id: "reproduce", title: "Reproduce the defect", state: "done" },
        { id: "root-cause", title: "Find the root cause", state: "skipped", reason: "Known" },
        { id: "bisect", title: "Bisect", state: "todo" },
      ],
    }),
    settled,
  ).steps;
  expect(steps.map((step) => [step.title, step.state, step.reason])).toEqual([
    ["Reproduce the defect", "Done", undefined],
    ["Find the root cause", "Skipped", "Known"],
    ["Bisect", "To do", undefined],
  ]);
});

test("a delivered run with a delivery step still to do is not Done", () => {
  const steps = [{ id: "report", title: "Report", state: "todo" as const }];
  expect(offshiftSummary(card({ steps }), settled)).toMatchObject({ word: "Waiting", done: false });
  const reported = [{ id: "report", title: "Report", state: "done" as const }];
  expect(offshiftSummary(card({ steps: reported }), settled).done).toBe(true);
});

test("the status line names the playbook first when the run started from one", () => {
  expect(offshiftSummary(card({ phase: "verify", playbook: "fix" }), settled).phase).toBe(
    "Fix · Verify · 3 of 5",
  );
  expect(offshiftSummary(card({ phase: "verify" }), settled).phase).toBe("Verify · 3 of 5");
});
