import { describe, expect, it } from "vitest";
import { releaseSummary, type JobOutcome } from "./release-summary.ts";

const url = "https://github.com/arpan404/ace/actions/runs/1";
const jobs = (overrides: Record<string, JobOutcome["result"]>): JobOutcome[] =>
  ["prepare", "build-mac", "build-linux", "upload", "notes", "deploy-production", "publish"].map(
    (job) => ({ job, result: overrides[job] ?? "success" }),
  );

describe("what the owner is told when a release run ends", () => {
  it("says the release is live when publish succeeded", () => {
    expect(releaseSummary({ tag: "v0.0.24", jobs: jobs({}), url })).toEqual({
      ok: true,
      title: "v0.0.24 is live",
      body: `Every step passed. ${url}`,
    });
  });

  it("names the first step that failed, not the steps skipped after it", () => {
    const summary = releaseSummary({
      tag: "v0.0.24",
      jobs: jobs({ "build-mac": "failure", "deploy-production": "skipped", publish: "skipped" }),
      url,
    });
    expect(summary).toMatchObject({ ok: false, title: "v0.0.24 stopped at build-mac" });
  });

  it("reports a cancelled step as cancelled", () => {
    const summary = releaseSummary({
      tag: "v0.0.24",
      jobs: jobs({ notes: "cancelled", publish: "skipped" }),
      url,
    });
    expect(summary.body).toMatch(/^notes was cancelled/);
  });

  it("is not a success when publish never ran", () => {
    expect(releaseSummary({ tag: "v0.0.24", jobs: jobs({ publish: "skipped" }), url }).ok).toBe(
      false,
    );
  });
});
