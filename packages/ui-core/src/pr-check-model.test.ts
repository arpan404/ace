import { describe, expect, it } from "vitest";
import type { ForgeCheckRun } from "@ace/protocol";
import {
  checkControls,
  checkFixRequest,
  checkLogNote,
  firstFailureLine,
} from "./pr-check-model.ts";

const workflow = { runId: 42, attempt: 1, jobId: 99, steps: [] };
const run = (patch: Partial<ForgeCheckRun> = {}): ForgeCheckRun => ({
  id: 11,
  name: "test",
  status: "failure",
  conclusion: "failure",
  url: null,
  output: { title: null, summary: null, text: null },
  workflow,
  log: { text: "step\nError: boom\n", truncated: false, errors: [1], focus: 1 },
  logUnavailable: false,
  annotations: [],
  annotationsTruncated: false,
  ...patch,
});

describe("what a check's page offers", () => {
  it("re-runs a failed workflow job and hands it to an agent on an open pull request", () => {
    expect(checkControls({ status: "failure" }, run(), true)).toEqual({
      rerunFailed: true,
      rerunAll: true,
      cancel: false,
      fix: true,
    });
  });

  it("only cancels a job that is still running", () => {
    expect(checkControls({ status: "pending" }, run(), true)).toEqual({
      rerunFailed: false,
      rerunAll: false,
      cancel: true,
      fix: false,
    });
  });

  it("offers nothing to run for another app's check, and no fix once the PR is merged", () => {
    expect(checkControls({ status: "failure" }, run({ workflow: null }), false)).toEqual({
      rerunFailed: false,
      rerunAll: false,
      cancel: false,
      fix: false,
    });
  });

  it("says a running job's log comes once it finishes", () => {
    expect(checkLogNote({ status: "pending" }, run({ log: null }))).toBe(
      "The log shows once this job finishes.",
    );
  });

  it("asks the agent about the failing log lines it read", () => {
    const request = checkFixRequest(
      { name: "test", url: null },
      { number: 7, url: "https://github.com/o/r/pull/7" },
      run(),
    );
    expect(request).toContain('The check "test" fails on PR #7');
    expect(request).toContain("Error: boom");
  });
});

const annotation = (level: "notice" | "warning" | "failure", message: string) => ({
  path: "src/a.ts",
  startLine: 3,
  endLine: 3,
  level,
  title: "",
  message,
});

describe("the line that says why a check failed", () => {
  it("is the first failure annotation over warnings and notices", () => {
    const annotations = [
      annotation("notice", "Node 22 is deprecated"),
      annotation("warning", "unused import"),
      annotation("failure", "expected 1 call, got 0\nat socket.test.ts:40"),
    ];
    expect(firstFailureLine(run({ annotations }))).toBe("expected 1 call, got 0");
  });

  it("falls back to the failing step's first error line in the log", () => {
    const steps = [
      { number: 1, name: "setup", status: "success" as const, line: 0 },
      { number: 2, name: "test", status: "failure" as const, line: 2 },
    ];
    const log = {
      text: "Warning: cache miss\nok\nrunning tests\n  FAIL socket.test.ts\n",
      truncated: false,
      errors: [0, 3],
      focus: 2,
    };
    expect(firstFailureLine(run({ log, workflow: { ...workflow, steps } }))).toBe(
      "FAIL socket.test.ts",
    );
  });

  it("uses another app's own title, and says nothing when the run says nothing", () => {
    const output = { title: "2 vulnerabilities found", summary: null, text: null };
    expect(firstFailureLine(run({ log: null, workflow: null, output }))).toBe(
      "2 vulnerabilities found",
    );
    expect(firstFailureLine(run({ log: null, workflow: null }))).toBeUndefined();
  });
});
