import { describe, expect, it } from "vitest";
import {
  betaTag,
  betaTitle,
  betaVersion,
  nextBetaBuild,
  nextPatch,
  parseBetaTag,
  parseBetaVersion,
  releaseLineOf,
} from "./release-line.ts";
import { isNewer } from "./version.ts";

const beta = { version: "0.0.24", build: 1 };

describe("beta names", () => {
  it("names a beta's tag, app version and title from one build", () => {
    expect(betaTag(beta)).toBe("ace-0.0.24-beta-1");
    expect(betaVersion(beta)).toBe("0.0.24-beta.1");
    expect(betaTitle(beta)).toBe("ace 0.0.24 beta 1");
  });

  it("reads back the beta its tag and its app version name", () => {
    const later = { version: "1.12.0", build: 14 };
    for (const name of [beta, later]) {
      expect(parseBetaTag(betaTag(name))).toEqual(name);
      expect(parseBetaVersion(betaVersion(name))).toEqual(name);
    }
  });

  it.each([
    ["a stable tag", "v0.0.23"],
    ["a preview tag", "v0.1.0-preview.1"],
    ["an ace- tag with no beta", "ace-0.0.24"],
    ["a build that isn't a number", "ace-0.0.24-beta-x"],
    ["the dated form", "ace-beta-2026-11-16-0.0.24-1"],
    ["no build number", "ace-0.0.24-beta-"],
    ["build zero", "ace-0.0.24-beta-0"],
    ["a leading zero in the build", "ace-0.0.24-beta-01"],
    ["a prerelease version inside", "ace-0.0.24-rc.1-beta-1"],
    ["a leading zero in the version", "ace-0.0.024-beta-1"],
    ["a dot before the build", "ace-0.0.24-beta.1"],
    ["anything after the build", "ace-0.0.24-beta-1-x"],
    ["no ace- prefix", "0.0.24-beta-1"],
  ])("is no beta tag: %s", (_case, tag) => {
    expect(parseBetaTag(tag)).toBeUndefined();
  });

  it.each([
    ["a stable version", "0.0.23"],
    ["another prerelease", "0.0.23-preview.1"],
    ["the dated form", "0.0.24-beta.20261116.1"],
    ["build zero", "0.0.24-beta.0"],
    ["a build that isn't a number", "0.0.24-beta.x"],
  ])("is no beta version: %s", (_case, version) => {
    expect(parseBetaVersion(version)).toBeUndefined();
  });

  it("refuses to name a beta from parts no tag could carry", () => {
    expect(() => betaTag({ ...beta, build: 0 })).toThrow();
    expect(() => betaTag({ ...beta, build: 1.5 })).toThrow();
    expect(() => betaVersion({ ...beta, version: "0.0.23-rc.1" })).toThrow();
  });

  it("previews the patch after the stable version by default", () => {
    expect(nextPatch("0.0.23")).toBe("0.0.24");
    expect(nextPatch("0.1.9")).toBe("0.1.10");
    expect(() => nextPatch("0.0.24-beta.1")).toThrow();
  });

  it("tells a beta build's version from a stable one", () => {
    expect(releaseLineOf("0.0.24-beta.1")).toBe("beta");
    expect(releaseLineOf("0.0.23")).toBe("stable");
    expect(releaseLineOf("development")).toBe("stable");
  });
});

describe("the order of releases", () => {
  it.each([
    ["the last stable", "0.0.23", "a beta of the next version", "0.0.24-beta.1"],
    ["beta 1", "0.0.24-beta.1", "beta 2", "0.0.24-beta.2"],
    ["beta 9", "0.0.24-beta.9", "beta 10", "0.0.24-beta.10"],
    ["the last beta", "0.0.24-beta.10", "its stable release", "0.0.24"],
  ])("%s comes before %s", (_older, older, _newer, newer) => {
    expect(isNewer(newer, older)).toBe(true);
    expect(isNewer(older, newer)).toBe(false);
  });
});

describe("the next beta's build number", () => {
  const tags = [
    "v0.0.23",
    "ace-0.0.23-beta-1",
    "ace-0.0.23-beta-2",
    "ace-0.0.22-beta-5",
    "ace-beta-2026-11-02-0.0.23-7",
    "ace-0.0.23-beta-x",
    "not-a-tag",
  ];

  it("counts on from that version's betas, ignoring tags of any other form", () => {
    expect(nextBetaBuild(tags, "0.0.23")).toBe(3);
  });

  it("starts at 1 for a version with no betas yet", () => {
    expect(nextBetaBuild(tags, "0.0.24")).toBe(1);
    expect(nextBetaBuild([], "0.0.23")).toBe(1);
  });

  it("goes past the highest number, so a gap or a removed beta is never reused", () => {
    expect(nextBetaBuild(["ace-0.0.23-beta-4"], "0.0.23")).toBe(5);
    expect(nextBetaBuild(["ace-0.0.23-beta-1", "ace-0.0.23-beta-3"], "0.0.23")).toBe(4);
    expect(nextBetaBuild(["ace-0.0.23-beta-10", "ace-0.0.23-beta-9"], "0.0.23")).toBe(11);
  });
});
