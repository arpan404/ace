import { describe, expect, it } from "vitest";
import { releaseForTag, type ReleaseFacts } from "./release-tag.ts";

const facts = (overrides: Partial<ReleaseFacts>): ReleaseFacts => ({
  tag: "v0.0.24",
  onMain: true,
  appVersion: "0.0.24",
  tags: ["v0.0.23", "ace-0.0.24-beta-1"],
  ...overrides,
});

describe("a pushed stable tag", () => {
  it("starts a stable release when package.json is already at its version", () => {
    expect(releaseForTag(facts({}))).toEqual({
      ok: true,
      release: { kind: "stable", tag: "v0.0.24", version: "0.0.24", title: "ace 0.0.24" },
    });
  });

  it("is refused until package.json is bumped to its version", () => {
    const verdict = releaseForTag(facts({ appVersion: "0.0.23" }));
    expect(verdict).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/bump it to 0.0.24/)],
    });
  });

  it("is refused when it isn't a plain X.Y.Z version", () => {
    expect(releaseForTag(facts({ tag: "v0.0.24-preview.1" })).ok).toBe(false);
    expect(releaseForTag(facts({ tag: "v0.0" })).ok).toBe(false);
  });
});

describe("a pushed beta tag", () => {
  it("starts a beta of the next version, built as its semver", () => {
    const verdict = releaseForTag(
      facts({
        tag: "ace-0.0.24-beta-2",
        appVersion: "0.0.23",
        tags: ["v0.0.23", "ace-0.0.24-beta-1", "ace-0.0.24-beta-2"],
      }),
    );
    expect(verdict).toEqual({
      ok: true,
      release: {
        kind: "beta",
        tag: "ace-0.0.24-beta-2",
        version: "0.0.24-beta.2",
        title: "ace 0.0.24 beta 2",
      },
    });
  });

  it("is refused when it skips a build number", () => {
    const verdict = releaseForTag(facts({ tag: "ace-0.0.24-beta-4", appVersion: "0.0.23" }));
    expect(verdict).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/skips a build number/)],
    });
  });

  it("is refused for a version stable already shipped", () => {
    expect(releaseForTag(facts({ tag: "ace-0.0.24-beta-2", appVersion: "0.0.24" })).ok).toBe(false);
  });
});

describe("any release tag", () => {
  it("is refused off main, with every other problem listed too", () => {
    const verdict = releaseForTag(facts({ onMain: false, appVersion: "0.0.23" }));
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok ? [] : verdict.problems).toHaveLength(2);
  });

  it("is refused when it is neither a stable nor a beta tag", () => {
    expect(releaseForTag(facts({ tag: "release-0.0.24" })).ok).toBe(false);
  });
});
