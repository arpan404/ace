import { expect, test } from "vitest";
import type { ForgeLocalStack, ForgeStack, ForgeStackExpected } from "@ace/protocol/forge-stacks";
import {
  planStackPublication,
  reconcileStackPublication,
  sameReviewedRevisions,
  stackPublishResult,
  stackPublishUpdates,
} from "./stack-publish.ts";

const reviewed = { model: "1".repeat(40), api: "2".repeat(40), ui: "3".repeat(40) };
const rebased = { model: "4".repeat(40), api: "5".repeat(40), ui: "6".repeat(40) };
const trunk = "0".repeat(40);
const numbers = { model: 7, api: 8, ui: 9 };
const names = ["model", "api", "ui"] as const;

function host(heads: Record<(typeof names)[number], string> = reviewed): ForgeStack {
  return {
    id: "STACK_42",
    number: 42,
    trunk: "main",
    canMerge: true,
    raw: {},
    layers: names.map((name, index) => ({
      number: numbers[name],
      position: index + 1,
      title: name,
      url: `https://github.com/octo/ace/pull/${numbers[name]}`,
      headSha: heads[name],
      branch: name,
      baseBranch: index === 0 ? "main" : (names[index - 1] ?? "main"),
      state: "OPEN",
      mergeState: "CLEAN",
      reviewDecision: null,
      checksState: null,
      requiredChecks: [],
      checksTruncated: false,
      queueState: null,
    })),
  };
}
function local(heads: Record<(typeof names)[number], string>, bases?: string[]): ForgeLocalStack {
  return {
    trunk: "main",
    currentBranch: "ui",
    branches: names.map((name, index) => ({
      name,
      head: heads[name],
      base: bases?.[index] ?? (index === 0 ? trunk : heads[names[index - 1] ?? "model"]),
      isCurrent: name === "ui",
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: {
        number: numbers[name],
        url: `https://github.com/octo/ace/pull/${numbers[name]}`,
        state: "OPEN",
      },
    })),
  };
}
function expected(stack: ForgeLocalStack): ForgeStackExpected {
  return {
    id: "STACK_42",
    trunk: "main",
    layers: names.map((name) => ({ number: numbers[name], headSha: reviewed[name] })),
    local: stack,
  };
}

test("each moved layer is leased to the revision reviewed before the rebase and unmoved layers are left alone", () => {
  const after = local({ ...rebased, model: reviewed.model }, [trunk, reviewed.model, rebased.api]);
  expect(planStackPublication(expected(after), after, host())).toEqual({
    ok: true,
    updates: [
      { number: 8, branch: "api", lease: reviewed.api, target: rebased.api },
      { number: 9, branch: "ui", lease: reviewed.ui, target: rebased.ui },
    ],
  });
});

test("a layer that does not sit on the layer below it blocks publication", () => {
  const after = local(rebased, [trunk, reviewed.model, rebased.api]);
  expect(planStackPublication(expected(after), after, host())).toEqual({
    ok: false,
    reason: "unrestacked",
  });
});

test("a collaborator commit on GitHub after review blocks publication", () => {
  const after = local(rebased);
  expect(
    planStackPublication(expected(after), after, host({ ...reviewed, api: "f".repeat(40) })),
  ).toEqual({ ok: false, reason: "moved" });
});

test("a local stack with nothing rebased has nothing to publish", () => {
  const before = local(reviewed);
  expect(planStackPublication(expected(before), before, host())).toEqual({
    ok: false,
    reason: "unchanged",
  });
});

function refs(status: "updated" | "rejected") {
  return names.map((name) => ({ ref: `refs/heads/${name}`, status, reason: null }));
}

test("an atomic push is published only when Git accepted every layer and refused when it rejected any", () => {
  const updates = stackPublishUpdates(expected(local(rebased)));
  expect(stackPublishResult(updates, { exitCode: 0, refs: refs("updated") })).toBe("published");
  expect(stackPublishResult(updates, { exitCode: 1, refs: refs("rejected") })).toBe("refused");
  expect(stackPublishResult(updates, { exitCode: 128, refs: [] })).toBe("unknown");
  expect(stackPublishResult(updates, { exitCode: 0, refs: refs("updated").slice(1) })).toBe(
    "unknown",
  );
});

test("a recorded publication settles from GitHub's heads without another push", () => {
  const updates = stackPublishUpdates(expected(local(rebased)));
  expect(reconcileStackPublication(updates, host(rebased))).toBe("published");
  expect(reconcileStackPublication(updates, host(reviewed))).toBe("unpublished");
  expect(reconcileStackPublication(updates, host({ ...reviewed, ui: rebased.ui }))).toBe("unknown");
});

test("a refreshed request cannot replace the host revisions reviewed for the rebase", () => {
  const first = expected(local(reviewed));
  expect(sameReviewedRevisions(first, { ...first, local: local(rebased) })).toBe(true);
  const refreshed = expected(local(rebased));
  refreshed.layers = names.map((name) => ({
    number: numbers[name],
    headSha: name === "api" ? "f".repeat(40) : reviewed[name],
  }));
  expect(sameReviewedRevisions(first, refreshed)).toBe(false);
});
