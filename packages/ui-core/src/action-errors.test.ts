import { expect, test } from "vitest";
import { actionErrorText, outcomeUncertain } from "./action-errors.ts";

// Every code the daemon's action errors can carry (`apps/daemon/src/action-errors.ts`: git codes
// as `git_<code>`, forge kinds as `forge_<kind>`) and the review service's refusals.
const git = [
  "missing",
  "too_old",
  "failed",
  "objects_not_available",
  "head_moved",
  "conflicts",
  "hook_failed",
  "auth_failed",
  "remote_unreachable",
  "remote_ref_not_found",
  "timeout",
  "cancelled",
  "closed",
  "busy",
  "quarantined",
  "malformed_output",
  "filesystem_error",
  "output_too_large",
  "not_a_repo",
  "invalid_argument",
  "invalid_ref",
  "pr_base_mismatch",
  "branch_exists",
  "dirty_worktree",
  "worktree_not_found",
  "main_worktree",
  "checkpoint_not_found",
  "restore_collision",
  "unsupported_repository",
  // The named failure causes in @ace/git's gitFailureCodes.
  "branch_checked_out",
  "path_exists",
  "ref_conflict",
  "unborn_head",
  "identity_missing",
  "nothing_to_commit",
  "push_rejected",
  "protected_branch",
].map((code) => `git_${code}`);
const forge = [
  "not_found",
  "forbidden",
  "rate_limit",
  "invalid_data",
  "limit",
  "cli",
  "cancelled",
  "unsupported",
  "conflict",
  "outcome_uncertain",
  "preferences_changed",
  // Write refusals and the forge browser's reconciliation states.
  "write_refused",
  "validation_failed",
  "head_moved",
  "version_mismatch",
  "no_remote",
  "status_unavailable",
  "action_reconciled",
  "write_pending",
  "write_uncertain",
].map((kind) => `forge_${kind}`);
const push = ["push_rejected", "push_lease_stale", "push_protected", "pr_head_unavailable"].map(
  (code) => `git_${code}`,
);
const connection = ["offline", "timeout", "maintenance", "action_not_dispatched"];
const review = [
  "review_not_found",
  "review_comment_unavailable",
  "review_reviewer_unavailable",
  "review_executor_unavailable",
  "review_queue_rejected",
  "review_target_mismatch",
  "review_suggestion_conflict",
  "review_suggestion_unavailable",
];
const general = actionErrorText(undefined);

test("every git, forge and review code reads as a sentence with its fix, never the raw code", () => {
  for (const code of [...git, ...push, ...forge, ...review, ...connection]) {
    const text = actionErrorText(code);
    expect(text, code).not.toBe(general);
    // A one-word code ("offline") may be a plain word in its own sentence.
    if (code.includes("_")) expect(text, code).not.toContain(code);
    // What went wrong, then after the colon (or a full stop) what to do about it.
    expect(text, code).toMatch(/^[A-Z][^:.]+[:.] .+\.$/);
  }
});

test("GitHub sign-in failures name the command that fixes them", () => {
  expect(actionErrorText("forge_cli")).toMatch(/^Sign in to GitHub: run `gh auth login`/);
  expect(actionErrorText("forge_cli")).toContain("install `gh`");
  expect(actionErrorText("git_auth_failed")).toContain("`gh auth login`");
});

test("an unknown code falls back to a general sentence instead of showing the code", () => {
  expect(actionErrorText("something_new")).toBe(general);
  expect(general).not.toContain("_");
});

test("a conflict while reading says refresh, while a refused write names what changed", () => {
  expect(actionErrorText("forge_conflict")).toMatch(/Refresh, then retry/);
  expect(actionErrorText("forge_head_moved")).toMatch(/branch moved/);
  expect(actionErrorText("forge_version_mismatch")).toMatch(/apply your edit again/);
  const writes = ["forge_write_refused", "forge_validation_failed", "forge_head_moved"];
  expect(new Set(writes.map(actionErrorText)).size).toBe(writes.length);
});

test("only a lost result fences a write; a clear refusal is definite", () => {
  for (const code of ["action_outcome_uncertain", "forge_write_uncertain", "offline", "timeout"])
    expect(outcomeUncertain(code), code).toBe(true);
  expect(outcomeUncertain(undefined)).toBe(true);
  for (const code of [
    "forge_conflict",
    "forge_forbidden",
    "forge_rate_limit",
    "action_not_dispatched",
  ])
    expect(outcomeUncertain(code), code).toBe(false);
});
