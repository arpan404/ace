import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { OffshiftRun, type OffshiftEvidence, type OffshiftView } from "@ace/protocol/offshift";
import { view } from "./index.ts";

const owner = {
  threadId: ThreadId.parse("00000000-0000-4000-8000-000000000001"),
  provider: "codex" as const,
  model: "gpt-5",
};
const child = {
  threadId: ThreadId.parse("00000000-0000-4000-8000-000000000002"),
  provider: "claude" as const,
  model: "opus",
};
function run(overrides: Partial<OffshiftRun> = {}): OffshiftRun {
  return OffshiftRun.parse({
    id: "restore",
    threadId: owner.threadId,
    outcome: "User can restore an item",
    endpoint: "Verified local change",
    criteria: [
      { id: "restore", description: "Restore persists", requiredKinds: ["automated", "ui"] },
    ],
    owner,
    phase: "verify",
    version: 3,
    blocker: null,
    note: "Observed",
    evidence: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}
const pass = (
  kind: "automated" | "ui",
  overrides: Partial<OffshiftEvidence> = {},
): OffshiftEvidence => ({
  criterionId: "restore",
  kind,
  result: "pass",
  revision: "r1",
  action: "Ran it",
  artifact: "report",
  note: "Holds",
  recordedAt: 1,
  by: owner,
  ...overrides,
});
const next = (
  value: OffshiftRun,
  treeState: OffshiftView["treeState"] = "working",
  children?: number,
) =>
  view(value, { revision: "r1", treeState, ...(children === undefined ? {} : { children }) }).next;

test("early phases say what to do before advancing", () => {
  expect(next(run({ phase: "plan" }))).toBe("Plan the work, then advance to implement.");
  expect(next(run({ phase: "implement" }))).toBe("Make the change, then advance to verify.");
});

test("a blocker comes first, whatever else is pending", () => {
  expect(next(run({ blocker: "Need a test account" }))).toBe(
    "Resolve the blocker: Need a test account. Ask the person if needed, then resume with the decision in note.",
  );
});

test("missing evidence names the kind, the criterion and the revision to record at", () => {
  expect(next(run())).toBe(
    "Record automated evidence for `restore` at revision r1 (1 more check pending).",
  );
  expect(next(run({ evidence: [pass("automated")] }))).toBe(
    "Record ui evidence for `restore` at revision r1.",
  );
});

test("a failed check asks for a fix and a stale pass asks for a repeat", () => {
  const failed = run({ evidence: [pass("automated", { result: "fail" }), pass("ui")] });
  expect(next(failed)).toBe(
    "Fix `restore`: its automated check failed. Then repeat the check and record the result.",
  );
  const stale = run({ evidence: [pass("automated", { revision: "r0" }), pass("ui")] });
  expect(next(stale)).toBe(
    "Repeat the automated check for `restore`: the source changed since it was recorded.",
  );
});

test("an independent criterion with only the owner's pass asks another model to verify", () => {
  const value = run({
    criteria: [
      { id: "restore", description: "Restore persists", requiredKinds: ["ui"], independent: true },
    ],
    evidence: [pass("ui")],
  });
  expect(next(value)).toBe(
    `Ask a different provider or model to verify \`restore\` (ui): delegate with runRole "verify" and tell the child runOwner "${owner.threadId}".`,
  );
  expect(next(run({ ...value, evidence: [pass("ui", { by: child })] }))).toBe("Advance to review.");
});

test("with every check passing, each phase points at the next one", () => {
  const passing = { evidence: [pass("automated"), pass("ui")] };
  expect(next(run(passing))).toBe("Advance to review.");
  expect(next(run({ ...passing, phase: "review" }))).toBe(
    "Review the change, then advance to delivery.",
  );
});

test("a delivered run waits on its tree, then reports", () => {
  const delivered = run({ phase: "delivery", evidence: [pass("automated"), pass("ui")] });
  expect(next(delivered, "working", 2)).toBe(
    "Wait for the tree: 2 children still working (call wait).",
  );
  // Only the caller's own turn is working: it reports and ends the turn.
  expect(next(delivered, "working", 0)).toBe(
    "Report the outcome and end your turn; the run completes when the tree settles.",
  );
  expect(next(delivered, "needs_you")).toBe(
    "The tree waits on the person: relay the request, or wait for their answer.",
  );
  expect(next(delivered, "failed")).toContain("agents_status");
  expect(next(delivered, "done")).toBe("Done. Report the outcome and the checks behind it.");
});

test("in order: a blocker, a failed check, the phase's next step, other pending checks, then advancing", () => {
  const steps = [
    {
      id: "same-surface",
      title: "Confirm on the same surface.",
      phase: "verify" as const,
      state: "todo" as const,
    },
  ];
  const step =
    "Step `same-surface`: Confirm on the same surface. Then call step: done with what you observed, or skipped with the reason.";
  const failing = run({ steps, evidence: [pass("automated", { result: "fail" })] });
  expect(next(run({ ...failing, blocker: "Need a device" }))).toContain("Resolve the blocker");
  expect(next(failing)).toBe(
    "Fix `restore`: its automated check failed. Then repeat the check and record the result (1 more check pending).",
  );
  expect(next(run({ steps }))).toBe(step);
  // A stale pass is pending, not failing: the step still comes first.
  expect(next(run({ steps, evidence: [pass("automated", { revision: "r0" }), pass("ui")] }))).toBe(
    step,
  );
  const marked = [
    {
      id: "same-surface",
      title: "Confirm on the same surface.",
      phase: "verify" as const,
      state: "done" as const,
      note: "Seen",
    },
  ];
  expect(next(run({ steps: marked }))).toBe(
    "Record automated evidence for `restore` at revision r1 (1 more check pending).",
  );
  expect(next(run({ steps: marked, evidence: [pass("automated"), pass("ui")] }))).toBe(
    "Advance to review.",
  );
});
