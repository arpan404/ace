import { describe, expect, it } from "vitest";
import { betaHostProblem, planBeta, remoteTagNames, stagedBeta } from "./beta-plan.ts";

describe("where a beta is built", () => {
  it.each([
    ["darwin", "arm64", true],
    ["darwin", "x64", false],
    ["linux", "arm64", false],
    ["linux", "x64", false],
    ["win32", "x64", false],
  ])("%s-%s builds betas: %s", (platform, arch, allowed) => {
    expect(betaHostProblem(platform, arch) === undefined).toBe(allowed);
  });
});

describe("the next beta", () => {
  const now = Date.UTC(2026, 10, 3, 23, 30);
  const listing = [
    "aaa\trefs/tags/v0.0.23",
    "bbb\trefs/tags/v0.0.23^{}",
    "ccc\trefs/tags/ace-beta-2026-11-03-0.0.23-1",
    "ddd\trefs/tags/ace-beta-2026-11-03-0.0.23-1^{}",
    "eee\trefs/tags/ace-beta-2026-11-02-0.0.23-4",
    "",
  ].join("\n");

  it("reads each tag GitHub has once", () => {
    expect(remoteTagNames(listing)).toEqual([
      "v0.0.23",
      "ace-beta-2026-11-03-0.0.23-1",
      "ace-beta-2026-11-02-0.0.23-4",
    ]);
  });

  it("is dated in UTC and numbered after that day's betas of the version", () => {
    expect(planBeta({ version: "0.0.23", now, tags: remoteTagNames(listing) })).toEqual({
      name: { date: "2026-11-03", version: "0.0.23", build: 2 },
      tag: "ace-beta-2026-11-03-0.0.23-2",
      version: "0.0.23-beta.20261103.2",
      title: "ace beta 2026-11-03 (0.0.23, build 2)",
    });
  });

  it("refuses to build on a version that isn't a stable release", () => {
    expect(() => planBeta({ version: "0.1.0-preview.1", now, tags: [] })).toThrow(/stable/);
  });
});

describe("which staged beta publishes", () => {
  const one = "ace-beta-2026-11-03-0.0.23-1";
  const two = "ace-beta-2026-11-03-0.0.23-2";

  it("is the only one staged, beside stable releases", () => {
    expect(stagedBeta(["v0.0.23", one], undefined)).toBe(one);
  });

  it("must be named when several are staged, and must exist when named", () => {
    expect(() => stagedBeta([one, two], undefined)).toThrow(/name one/);
    expect(stagedBeta([one, two], two)).toBe(two);
    expect(() => stagedBeta([one], two)).toThrow(/Nothing staged/);
    expect(() => stagedBeta([one], "v0.0.23")).toThrow(/not a beta/);
    expect(() => stagedBeta(["v0.0.23"], undefined)).toThrow(/No beta/);
  });
});
