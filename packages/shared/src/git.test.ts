import { describe, expect, it } from "vitest";
import { requiresDefaultBranchConfirmation, resolveDefaultBranchActionDialogCopy } from "./git";

describe("default branch git action copy", () => {
  it("requires confirmation for push and PR actions on the default branch", () => {
    expect(requiresDefaultBranchConfirmation("push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("create_pr", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit_push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit_push_pr", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit", true)).toBe(false);
    expect(requiresDefaultBranchConfirmation("push", false)).toBe(false);
  });

  it("uses push-only copy when pushing without a commit", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "push",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("uses push-and-pr copy when creating a PR without a commit", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "create_pr",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push & create PR from default branch?",
      description:
        'This action will push local commits and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push & create PR",
    });
  });
});
