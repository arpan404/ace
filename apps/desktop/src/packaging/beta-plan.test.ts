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
  const now = Date.UTC(2026, 10, 16, 23, 30);
  const listing = [
    "aaa\trefs/tags/v0.0.23",
    "bbb\trefs/tags/v0.0.23^{}",
    "ccc\trefs/tags/ace-beta-2026-11-16-0.0.24-1",
    "ddd\trefs/tags/ace-beta-2026-11-16-0.0.24-1^{}",
    "eee\trefs/tags/ace-beta-2026-11-15-0.0.24-4",
    "",
  ].join("\n");
  const tags = remoteTagNames(listing);

  it("reads each tag GitHub has once", () => {
    expect(tags).toEqual([
      "v0.0.23",
      "ace-beta-2026-11-16-0.0.24-1",
      "ace-beta-2026-11-15-0.0.24-4",
    ]);
  });

  it("previews the next patch, dated in UTC and numbered after that day's betas of it", () => {
    expect(planBeta({ stable: "0.0.23", now, tags })).toEqual({
      name: { date: "2026-11-16", version: "0.0.24", build: 2 },
      tag: "ace-beta-2026-11-16-0.0.24-2",
      version: "0.0.24-beta.20261116.2",
      title: "ace beta 2026-11-16 (0.0.24, build 2)",
    });
  });

  it("starts at build 1 on a day with no betas of that version yet", () => {
    const tomorrow = Date.UTC(2026, 10, 17, 0, 5);
    expect(planBeta({ stable: "0.0.23", now: tomorrow, tags }).tag).toBe(
      "ace-beta-2026-11-17-0.0.24-1",
    );
  });

  it("previews a later version the person names, counted on its own", () => {
    expect(planBeta({ stable: "0.0.23", version: "0.1.0", now, tags })).toMatchObject({
      tag: "ace-beta-2026-11-16-0.1.0-1",
      version: "0.1.0-beta.20261116.1",
    });
  });

  it.each([
    ["the last stable itself", "0.0.23"],
    ["an older version", "0.0.22"],
    ["a prerelease", "0.0.24-rc.1"],
  ])("refuses --version as %s", (_what, version) => {
    expect(() => planBeta({ stable: "0.0.23", version, now, tags })).toThrow(/--version/);
  });

  it("refuses to build on a version that isn't a stable release", () => {
    expect(() => planBeta({ stable: "0.1.0-preview.1", now, tags: [] })).toThrow(/stable/);
  });
});

describe("which staged beta publishes", () => {
  const one = "ace-beta-2026-11-16-0.0.24-1";
  const two = "ace-beta-2026-11-16-0.0.24-2";

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
