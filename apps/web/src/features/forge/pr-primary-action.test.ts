import { expect, test } from "vitest";
import { ForgeMergeState, type ForgePrStatus } from "@ace/protocol";
import { prPrimaryAction, prPrimaryLabel } from "./pr-primary-action.ts";

const status = (
  patch: Partial<Pick<ForgePrStatus, "state" | "mergeability" | "ci" | "checks">> = {},
): Pick<ForgePrStatus, "state" | "mergeability" | "ci" | "checks"> => ({
  state: "open",
  mergeability: "mergeable",
  ci: "success",
  checks: [],
  ...patch,
});
const mergeState = (patch: Partial<ForgeMergeState> = {}) =>
  ForgeMergeState.parse({
    headSha: "a".repeat(40),
    state: "OPEN",
    mergeState: "CLEAN",
    reviewDecision: null,
    checksState: null,
    autoMerge: null,
    queue: null,
    canEnable: true,
    canDisable: false,
    canDequeue: false,
    blockers: [],
    raw: {},
    ...patch,
  });
const label = (input: Parameters<typeof prPrimaryAction>[0]) =>
  prPrimaryLabel(prPrimaryAction(input));

test("a mergeable PR with passing checks offers the chosen merge method", () => {
  expect(label({ status: status(), mergeState: mergeState(), method: "squash" })).toBe(
    "Squash and merge",
  );
  expect(label({ status: status(), mergeState: undefined, method: "rebase" })).toBe(
    "Rebase and merge",
  );
});

test("merged and closed PRs show their state instead of any action", () => {
  expect(
    label({ status: status({ state: "merged" }), mergeState: undefined, method: "squash" }),
  ).toBe("Merged");
  expect(
    prPrimaryAction({
      status: status({ state: "closed" }),
      mergeState: undefined,
      method: "squash",
    }),
  ).toEqual({ kind: "state", state: "closed" });
});

test("conflicts outrank draft and auto-merge", () => {
  const conflicting = status({ state: "draft", mergeability: "conflicting" });
  expect(
    label({
      status: conflicting,
      mergeState: mergeState({ autoMerge: { method: "SQUASH", actor: null, enabledAt: "x" } }),
      method: "squash",
    }),
  ).toBe("Resolve conflicts");
});

test("a draft asks to be marked ready", () => {
  expect(
    label({ status: status({ state: "draft" }), mergeState: undefined, method: "merge" }),
  ).toBe("Ready for review");
});

test("running checks offer auto-merge only when the host allows enabling it", () => {
  const running = status({ ci: "pending" });
  expect(label({ status: running, mergeState: mergeState(), method: "squash" })).toBe(
    "Auto-merge (squash)",
  );
  expect(
    prPrimaryAction({
      status: running,
      mergeState: mergeState({ canEnable: false }),
      method: "squash",
    }).kind,
  ).toBe("merge");
});

test("failing checks never offer auto-merge, even where the host would allow it", () => {
  expect(
    prPrimaryAction({
      status: status({ ci: "failure" }),
      mergeState: mergeState(),
      method: "squash",
    }).kind,
  ).toBe("merge");
});

test("armed auto-merge and a queued PR show what GitHub will do", () => {
  expect(
    prPrimaryAction({
      status: status({ ci: "pending" }),
      mergeState: mergeState({ autoMerge: { method: "REBASE", actor: "octo", enabledAt: "x" } }),
      method: "squash",
    }),
  ).toEqual({ kind: "auto-merge-armed", method: "rebase" });
  expect(
    label({
      status: status(),
      mergeState: mergeState({
        queue: { id: "Q", state: "QUEUED", position: 2, enqueuedAt: "x" },
      }),
      method: "squash",
    }),
  ).toBe("In merge queue · 2");
});
