import { expect, test } from "vitest";
import { codexReviewerMode } from "@ace/provider-kit/permission-modes";
import { codexThreadPolicy, codexTurnPolicy } from "./permission-policy.ts";

test.each([
  [":read-only", { permissions: ":read-only" }],
  [":workspace", { permissions: ":workspace" }],
  [":danger-full-access", { permissions: ":danger-full-access" }],
  [
    codexReviewerMode("auto_review"),
    { permissions: ":workspace", approvalsReviewer: "auto_review" },
  ],
  [
    codexReviewerMode("guardian_subagent"),
    { permissions: ":workspace", approvalsReviewer: "guardian_subagent" },
  ],
])(
  "ace mode %s names the native Codex profile and reviewer for thread and turn",
  (mode, policy) => {
    expect(codexThreadPolicy(mode, "/repo")).toEqual(policy);
    expect(codexTurnPolicy(mode, "/repo")).toEqual(policy);
  },
);

test("no chosen mode leaves Codex's own configuration in place", () => {
  expect(codexThreadPolicy(null, "/repo")).toEqual({});
});
