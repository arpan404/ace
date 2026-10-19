import { expect, test } from "vitest";
import { ForgeMergeState, type ForgeCheck } from "@ace/protocol";
import { mergeBlockers, prGates, type GateFacts } from "./pr-gates.ts";

const check = (name: string, status: ForgeCheck["status"]): ForgeCheck => ({
  id: name,
  name,
  status,
  conclusion: null,
  completedAt: null,
  jobId: null,
  url: null,
});
const mergeState = (mergeStateValue: string) =>
  ForgeMergeState.parse({
    headSha: "a".repeat(40),
    state: "OPEN",
    mergeState: mergeStateValue,
    reviewDecision: null,
    checksState: null,
    autoMerge: null,
    queue: null,
    canEnable: false,
    canDisable: false,
    canDequeue: false,
    blockers: [],
    raw: {},
  });
const facts = (patch: Partial<GateFacts> = {}): GateFacts => ({
  status: { state: "open", mergeability: "mergeable", ci: "success", checks: [] },
  reviewDecision: null,
  mergeState: undefined,
  baseBranch: "main",
  outcomes: new Map(),
  ...patch,
});
const said = (input: GateFacts) =>
  Object.fromEntries(prGates(input).map((gate) => [gate.key, `${gate.value} (${gate.tone})`]));

test("a PR ready to merge shows every gate clear", () => {
  expect(
    said(
      facts({
        status: {
          state: "open",
          mergeability: "mergeable",
          ci: "success",
          checks: [check("lint", "success"), check("test", "success")],
        },
        reviewDecision: "APPROVED",
        outcomes: new Map([["mira", "approved"]]),
        mergeState: mergeState("CLEAN"),
      }),
    ),
  ).toEqual({
    checks: "2 passed (done)",
    reviews: "1 approved (done)",
    conflicts: "None (done)",
    branch: "Up to date (done)",
  });
});

test("a failing check, requested changes, conflicts and a stale branch each say so", () => {
  expect(
    said(
      facts({
        status: {
          state: "open",
          mergeability: "conflicting",
          ci: "failure",
          checks: [check("links", "failure"), check("lint", "success"), check("build", "success")],
        },
        reviewDecision: "CHANGES_REQUESTED",
        mergeState: mergeState("BEHIND"),
      }),
    ),
  ).toEqual({
    checks: "1 failing · 2 ok (failed)",
    reviews: "Changes requested (failed)",
    conflicts: "Conflicting (failed)",
    branch: "Behind (needs-you)",
  });
});

test("running checks and an outstanding review read as waiting, not done", () => {
  const gates = said(
    facts({
      status: {
        state: "open",
        mergeability: "unknown",
        ci: "pending",
        checks: [check("test", "pending"), check("lint", "success")],
      },
      reviewDecision: "REVIEW_REQUIRED",
    }),
  );
  expect(gates.checks).toBe("Running 1 (working)");
  expect(gates.reviews).toBe("Review required (needs-you)");
  expect(gates.conflicts).toBe("Checking (working)");
});

test("a merged PR shows who merged it, where it went and what became of the branch", () => {
  expect(
    said(
      facts({
        status: { state: "merged", mergeability: "unknown", ci: "success", checks: [] },
        ended: { by: "sam", ago: "41m ago" },
        branchDeleted: true,
      }),
    ),
  ).toEqual({
    ended: "sam (waiting)",
    into: "main (idle)",
    checks: "No checks (idle)",
    branch: "Deleted (idle)",
  });
});

test("a finished PR's time sits on its own line, so the value stays short enough to show whole", () => {
  const [ended] = prGates(
    facts({
      status: { state: "merged", mergeability: "unknown", ci: "none", checks: [] },
      ended: { by: "arpan404", ago: "3d ago" },
    }),
  );
  expect(ended?.value).toBe("arpan404");
  expect(ended?.detail).toBe("3d ago");
  for (const gate of prGates(facts({ reviewDecision: "CHANGES_REQUESTED" })))
    expect(gate.value.length).toBeLessThanOrEqual(18);
});

test("only failing checks and requested changes block a merge", () => {
  expect(
    mergeBlockers(
      prGates(
        facts({
          status: {
            state: "open",
            mergeability: "mergeable",
            ci: "failure",
            checks: [check("links", "failure"), check("lint", "success")],
          },
          reviewDecision: "CHANGES_REQUESTED",
          mergeState: mergeState("BEHIND"),
        }),
      ),
    ),
  ).toEqual(["Checks: 1 failing · 1 ok", "Reviews: Changes requested"]);
  expect(mergeBlockers(prGates(facts({ reviewDecision: "REVIEW_REQUIRED" })))).toEqual([]);
});
