import { expect, test } from "vitest";
import { actionErrorText } from "./action-errors.ts";

// Every code the daemon's action errors can carry (`apps/daemon/src/action-errors.ts`: git codes
// as `git_<code>`, forge kinds as `forge_<kind>`) and the review service's refusals.
const git = [
  "missing",
  "too_old",
  "failed",
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
  "branch_exists",
  "dirty_worktree",
  "worktree_not_found",
  "main_worktree",
  "checkpoint_not_found",
  "restore_collision",
  "unsupported_repository",
].map((code) => `git_${code}`);
const forge = [
  "auth",
  "not_found",
  "forbidden",
  "rate_limit",
  "invalid_data",
  "limit",
  "cli",
  "cancelled",
  "unsupported",
  "conflict",
].map((kind) => `forge_${kind}`);
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
  for (const code of [...git, ...forge, ...review]) {
    const text = actionErrorText(code);
    expect(text, code).not.toBe(general);
    expect(text, code).not.toContain(code);
    // What went wrong, then after the colon (or a full stop) what to do about it.
    expect(text, code).toMatch(/^[A-Z][^:.]+[:.] .+\.$/);
  }
});

test("GitHub sign-in failures name the command that fixes them", () => {
  expect(actionErrorText("forge_auth")).toBe("Sign in to GitHub: run `gh auth login`, then retry.");
  expect(actionErrorText("forge_cli")).toContain("`gh auth login`");
  expect(actionErrorText("git_auth_failed")).toContain("`gh auth login`");
});

test("an unknown code falls back to a general sentence instead of showing the code", () => {
  expect(actionErrorText("something_new")).toBe(general);
  expect(general).not.toContain("_");
});
