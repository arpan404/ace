import { describe, expect, it } from "vitest";
import type { ForgeCheckRun } from "@ace/protocol";
import { checkControls, checkFixRequest, checkLogNote } from "./pr-check-model.ts";

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
