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
  const listing = [
    "aaa\trefs/tags/v0.0.23",
    "bbb\trefs/tags/v0.0.23^{}",
    "ccc\trefs/tags/ace-0.0.24-beta-1",
    "ddd\trefs/tags/ace-0.0.24-beta-1^{}",
    "eee\trefs/tags/ace-0.0.24-beta-9",
    "fff\trefs/tags/ace-beta-2026-11-15-0.0.24-40",
    "",
  ].join("\n");
  const tags = remoteTagNames(listing);

  it("reads each tag GitHub has once", () => {
    expect(tags).toEqual([
      "v0.0.23",
      "ace-0.0.24-beta-1",
      "ace-0.0.24-beta-9",
      "ace-beta-2026-11-15-0.0.24-40",
    ]);
  });

  it("previews the next patch, numbered after the highest beta of it", () => {
    expect(planBeta({ stable: "0.0.23", tags })).toEqual({
      name: { version: "0.0.24", build: 10 },
      tag: "ace-0.0.24-beta-10",
      version: "0.0.24-beta.10",
      title: "ace 0.0.24 beta 10",
    });
  });

  it("starts at beta 1 for a version with no betas yet", () => {
    expect(planBeta({ stable: "0.0.23", tags: ["v0.0.23"] }).tag).toBe("ace-0.0.24-beta-1");
  });

  it("previews a later version the person names, counted on its own", () => {
    expect(planBeta({ stable: "0.0.23", version: "0.1.0", tags })).toMatchObject({
      tag: "ace-0.1.0-beta-1",
      version: "0.1.0-beta.1",
    });
  });

  it.each([
    ["the last stable itself", "0.0.23"],
    ["an older version", "0.0.22"],
    ["a prerelease", "0.0.24-rc.1"],
  ])("refuses --version as %s", (_what, version) => {
    expect(() => planBeta({ stable: "0.0.23", version, tags })).toThrow(/--version/);
  });

  it("refuses to build on a version that isn't a stable release", () => {
    expect(() => planBeta({ stable: "0.1.0-preview.1", tags: [] })).toThrow(/stable/);
  });
});

describe("which staged beta publishes", () => {
  const one = "ace-0.0.24-beta-1";
  const two = "ace-0.0.24-beta-2";

  it("is the only beta staged, beside folders of any other name", () => {
    expect(stagedBeta(["v0.0.23", "ace-beta-2026-11-16-0.0.24-1", one], undefined)).toBe(one);
  });

  it("must be named when several are staged, and must exist when named", () => {
    expect(() => stagedBeta([one, two], undefined)).toThrow(/name one/);
    expect(stagedBeta([one, two], two)).toBe(two);
    expect(() => stagedBeta([one], two)).toThrow(/Nothing staged/);
    expect(() => stagedBeta([one], "v0.0.23")).toThrow(/not a beta/);
    expect(() => stagedBeta(["v0.0.23"], undefined)).toThrow(/No beta/);
  });
});
