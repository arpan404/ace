import { expect, test } from "vitest";
import type { OffshiftRunCard } from "@ace/protocol/offshift";
import {
  advanceOperation,
  endOperation,
  evidenceOperation,
  nextCriterionId,
  offshiftControls,
  offshiftFailure,
  offshiftRunId,
  resumeOperation,
  reviseOperation,
  startOperation,
  stepOperation,
} from "./offshift-controls.ts";

function card(overrides: Partial<OffshiftRunCard> = {}): OffshiftRunCard {
  return {
    id: "login",
    outcome: "Login shows a helpful error",
    outcomeTruncated: false,
    endpoint: "Local change",
    phase: "implement",
    blocker: null,
    version: 5,
    updatedAt: 1,
    revision: "r1",
    criteria: [
      {
        id: "c1",
        description: "Bad password shows an error",
        independent: false,
        evidence: [{ kind: "ui", state: "missing", recordedAt: null, by: null }],
      },
    ],
    criteriaCount: 1,
    pending: [{ criterionId: "c1", kind: "ui" }],
    pendingCount: 1,
    steps: [{ id: "repro", title: "Reproduce the defect", state: "todo" }],
    ...overrides,
  };
}

test("an ended run offers no controls", () => {
  expect(offshiftControls(card({ ended: true }))).toBeNull();
});

test("a blocked run disables forward and offers resume", () => {
  const controls = offshiftControls(card({ blocker: "Need a test account" }));
  expect(controls?.forward?.disabled).toBe("Resolve the blocker first");
  expect(controls?.back?.disabled).toBe("Resolve the blocker first");
  expect(controls?.resume).toBe(true);
});

test("forward names unfinished steps before missing checks", () => {
  const controls = offshiftControls(card({ phase: "implement" }));
  expect(controls?.forward?.disabled).toBe("1 step still to do");
  expect(controls?.forward?.label).toBe("Move to Verify");
  expect(controls?.steps).toEqual([{ id: "repro", label: "Mark done", state: "done" }]);
  const done = offshiftControls(
    card({ phase: "implement", steps: [{ id: "repro", title: "Reproduce", state: "done" }] }),
  );
  expect(done?.steps).toEqual([{ id: "repro", label: "Mark not done", state: "todo" }]);
});

test("starting a run needs a goal, a criterion and how each is checked", () => {
  expect(startOperation({ goal: "  ", doneWhen: "", criteria: [] }, "r1").ok).toBe(false);
  expect(
    startOperation({ goal: "Fix login", doneWhen: "", criteria: [{ description: "  ", kinds: ["ui"] }] }, "r1"),
  ).toMatchObject({ ok: false, reason: "Add at least one criterion" });
  expect(
    startOperation(
      { goal: "Fix login", doneWhen: "", criteria: [{ description: "Shows error", kinds: [] }] },
      "r1",
    ),
  ).toMatchObject({ ok: false, reason: "Choose how each criterion is checked" });
  const started = startOperation(
    {
      goal: " Fix login ",
      doneWhen: "  ",
      criteria: [
        { description: " Shows error ", kinds: ["ui", "ui"], independent: true },
        { description: "  ", kinds: ["ui"] },
      ],
      playbook: "fix",
    },
    "person-abc",
  );
  expect(started).toMatchObject({
    ok: true,
    op: {
      action: "start",
      runId: "person-abc",
      outcome: "Fix login",
      endpoint: "Reported in this thread",
      criteria: [{ id: "c1", description: "Shows error", requiredKinds: ["ui"], independent: true }],
      playbook: "fix",
    },
  });
});

test("a check needs words and carries the card's version and revision", () => {
  expect(
    evidenceOperation(card(), { criterionId: "c1", kind: "ui", result: "pass", note: "  ", link: "" }),
  ).toMatchObject({ ok: false, reason: "Say what you checked" });
  expect(
    evidenceOperation(card(), {
      criterionId: "c1",
      kind: "ui",
      result: "pass",
      note: " Saw the error ",
      link: "  ",
    }),
  ).toMatchObject({
    ok: true,
    op: {
      action: "evidence",
      runId: "login",
      expectedVersion: 5,
      revision: "r1",
      note: "Saw the error",
    },
  });
});

test("revising a criterion needs words and how it is checked", () => {
  expect(reviseOperation(card(), "c1", { description: "  ", kinds: ["ui"] }).ok).toBe(false);
  expect(reviseOperation(card(), "c1", { description: "Shows error", kinds: [] }).ok).toBe(false);
  expect(
    reviseOperation(card(), "c1", { description: " Shows error ", kinds: ["ui"], independent: true }),
  ).toMatchObject({
    ok: true,
    op: {
      action: "revise",
      expectedVersion: 5,
      criterion: { id: "c1", description: "Shows error", requiredKinds: ["ui"], independent: true },
    },
  });
});

test("marking a step keeps the note only when done", () => {
  expect(stepOperation(card(), "repro", "done", " Saw it ")).toMatchObject({
    ok: true,
    op: {
      action: "step",
      expectedVersion: 5,
      stepId: "repro",
      state: "done",
      note: "Saw it",
    },
  });
  expect(stepOperation(card(), "repro", "todo", " Saw it ")).toMatchObject({
    ok: true,
    op: { action: "step", expectedVersion: 5, stepId: "repro", state: "todo" },
  });
  const todo = stepOperation(card(), "repro", "todo", " Saw it ");
  expect(todo.ok).toBe(true);
  if (todo.ok) expect(todo.op).not.toHaveProperty("note");
  expect(stepOperation(card(), "repro", "done", "x".repeat(1025)).ok).toBe(false);
});

test("advancing, resuming and ending carry the card's version", () => {
  expect(advanceOperation(card(), "verify")).toMatchObject({
    ok: true,
    op: { action: "advance", expectedVersion: 5, phase: "verify" },
  });
  expect(resumeOperation(card(), "  ").ok).toBe(false);
  expect(resumeOperation(card(), " Got the account ")).toMatchObject({
    ok: true,
    op: { action: "resume", expectedVersion: 5, note: "Got the account" },
  });
  expect(endOperation(card(), "  ")).toMatchObject({
    ok: true,
    op: { action: "end", expectedVersion: 5 },
  });
  expect(endOperation(card(), " Done for now ")).toMatchObject({
    ok: true,
    op: { note: "Done for now" },
  });
});

test("run ids stay unique per time and suffix, and criterion ids skip taken ones", () => {
  expect(offshiftRunId(10, "!!")).toBe("person-a-run");
  expect(offshiftRunId(10, "abc-123-xyz")).toMatch(/^person-a-abc123xy$/);
  expect(nextCriterionId(["c1", "c2"])).toBe("c3");
  expect(nextCriterionId(["c1", "c3"])).toBe("c4");
});

test("a refusal says what to do in one line", () => {
  expect(offshiftFailure({ ok: true })).toBeUndefined();
  expect(offshiftFailure({ ok: false, error: "conflict" })).toContain("Look at it again");
  expect(offshiftFailure({ ok: false, error: "forbidden" })).toContain("operate access");
  expect(offshiftFailure({ ok: false, error: "not_found" })).toContain("no longer exists");
  expect(offshiftFailure({ ok: false, error: "unavailable" })).toContain("workspace");
  expect(offshiftFailure({ ok: false, error: "invalid", message: "No such step" })).toContain(
    "No such step",
  );
});
