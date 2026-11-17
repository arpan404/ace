import { describe, expect, it } from "vitest";
import {
  betaDate,
  betaTag,
  betaTitle,
  betaVersion,
  nextBetaBuild,
  parseBetaTag,
  parseBetaVersion,
  releaseLineOf,
} from "./release-line.ts";

const beta = { date: "2026-11-03", version: "0.0.23", build: 1 };

describe("beta names", () => {
  it("names a beta's tag, app version and title from one build", () => {
    expect(betaTag(beta)).toBe("ace-beta-2026-11-03-0.0.23-1");
    expect(betaVersion(beta)).toBe("0.0.23-beta.20261103.1");
    expect(betaTitle(beta)).toBe("ace beta 2026-11-03 (0.0.23, build 1)");
  });

  it("reads back the beta its tag and its app version name", () => {
    const later = { date: "2027-01-31", version: "1.12.0", build: 14 };
    for (const name of [beta, later]) {
      expect(parseBetaTag(betaTag(name))).toEqual(name);
      expect(parseBetaVersion(betaVersion(name))).toEqual(name);
    }
  });

  it.each([
    ["a stable tag", "v0.0.23"],
    ["a preview tag", "v0.1.0-preview.1"],
    ["no build number", "ace-beta-2026-11-03-0.0.23"],
    ["build zero", "ace-beta-2026-11-03-0.0.23-0"],
    ["a leading zero in the build", "ace-beta-2026-11-03-0.0.23-01"],
    ["a day that doesn't exist", "ace-beta-2026-02-30-0.0.23-1"],
    ["month 13", "ace-beta-2026-13-01-0.0.23-1"],
    ["a prerelease version inside", "ace-beta-2026-11-03-0.0.23-rc.1-1"],
    ["a leading zero in the version", "ace-beta-2026-11-03-0.0.023-1"],
    ["anything after the build", "ace-beta-2026-11-03-0.0.23-1-x"],
  ])("is no beta tag: %s", (_case, tag) => {
    expect(parseBetaTag(tag)).toBeUndefined();
  });

  it.each([
    ["a stable version", "0.0.23"],
    ["another prerelease", "0.0.23-preview.1"],
    ["a short date", "0.0.23-beta.2026113.1"],
    ["a day that doesn't exist", "0.0.23-beta.20260230.1"],
    ["build zero", "0.0.23-beta.20261103.0"],
  ])("is no beta version: %s", (_case, version) => {
    expect(parseBetaVersion(version)).toBeUndefined();
  });

  it("refuses to name a beta from parts no tag could carry", () => {
    expect(() => betaTag({ ...beta, build: 0 })).toThrow();
    expect(() => betaTag({ ...beta, date: "2026-11-3" })).toThrow();
    expect(() => betaVersion({ ...beta, version: "0.0.23-rc.1" })).toThrow();
  });

  it("dates a build in UTC, whatever the local time zone", () => {
    expect(betaDate(Date.UTC(2026, 10, 3, 23, 59, 59))).toBe("2026-11-03");
    expect(betaDate(Date.UTC(2026, 10, 4, 0, 0, 0))).toBe("2026-11-04");
  });

  it("tells a beta build's version from a stable one", () => {
    expect(releaseLineOf("0.0.23-beta.20261103.1")).toBe("beta");
    expect(releaseLineOf("0.0.23")).toBe("stable");
    expect(releaseLineOf("development")).toBe("stable");
  });
});

describe("the next beta's build number", () => {
  const tags = [
    "v0.0.23",
    "ace-beta-2026-11-03-0.0.23-1",
    "ace-beta-2026-11-03-0.0.23-2",
    "ace-beta-2026-11-03-0.0.22-5",
    "ace-beta-2026-11-02-0.0.23-7",
    "not-a-tag",
  ];

  it("counts on from that date's betas of that version", () => {
    expect(nextBetaBuild(tags, "2026-11-03", "0.0.23")).toBe(3);
  });

  it("starts at 1 on a new date or a new version", () => {
    expect(nextBetaBuild(tags, "2026-11-04", "0.0.23")).toBe(1);
    expect(nextBetaBuild(tags, "2026-11-03", "0.0.24")).toBe(1);
    expect(nextBetaBuild([], "2026-11-03", "0.0.23")).toBe(1);
  });

  it("never reuses a number, even when an earlier one is gone", () => {
    expect(nextBetaBuild(["ace-beta-2026-11-03-0.0.23-4"], "2026-11-03", "0.0.23")).toBe(5);
  });
});
