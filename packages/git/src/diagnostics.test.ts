import { expect, test } from "vitest";
import { GitDiagnostics } from "./diagnostics.ts";

function trace(event: object) {
  return `${JSON.stringify(event)}\n`;
}

function classify(stderr: string) {
  const diagnostics = new GitDiagnostics();
  diagnostics.accept(Buffer.from(stderr));
  return diagnostics.finish();
}

// How each failure reaches the caller as a generic "Git command failed" error is proved through
// real Git in client-actions.process.test.ts.
test.each([
  ["fatal: Authentication failed for https://token@example.org/private", "auth_failed"],
  ["fatal: private /home/user/repo failed", "git_failed"],
  ["fatal: Could not resolve host: example.invalid", "remote_unreachable"],
])("a push failure saying %s is classified as %s", (stderr, code) => {
  expect(classify(stderr)).toBe(code);
});

test("successful hook traces do not misclassify a subsequent command failure", () => {
  expect(
    classify(
      trace({ event: "child_start", sid: "a", child_id: 0, child_class: "hook" }) +
        trace({ event: "child_exit", sid: "a", child_id: 0, code: 0 }) +
        "fatal: unrelated command failure\n",
    ),
  ).toBe("git_failed");
});
