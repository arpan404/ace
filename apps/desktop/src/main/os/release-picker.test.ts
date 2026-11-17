import { describe, expect, it } from "vitest";
import {
  blockedSentence,
  guardSwitch,
  parseReleaseList,
  pickRelease,
  type ListedRelease,
} from "./release-picker.ts";

const stable = (version: string): ListedRelease => ({
  tag: `v${version}`,
  draft: false,
  prerelease: false,
  body: `stable ${version}`,
});
const beta = (tag: string): ListedRelease => ({ tag, draft: false, prerelease: true, body: tag });

// Stable 0.0.23 is out; betas preview 0.0.24, two of them on the 16th.
const releases = [
  stable("0.0.22"),
  stable("0.0.23"),
  beta("ace-beta-2026-11-15-0.0.24-3"),
  beta("ace-beta-2026-11-16-0.0.24-1"),
  beta("ace-beta-2026-11-16-0.0.24-2"),
  beta("ace-beta-2026-11-01-0.0.23-9"),
];
const newestBeta = "ace-beta-2026-11-16-0.0.24-2";

describe("the release on offer", () => {
  it.each([
    // [what, installed, line, list, offered tag or "current", older]
    ["Stable offers the newest stable", "0.0.22", "stable", releases, "v0.0.23", false],
    ["Stable never offers a beta", "0.0.23", "stable", releases, "current", false],
    ["a 0.0.24 beta outranks stable 0.0.23", "0.0.23", "beta", releases, newestBeta, false],
    [
      "the second beta of a day outranks the first",
      "0.0.24-beta.20261116.1",
      "beta",
      releases,
      newestBeta,
      false,
    ],
    [
      "a later date outranks a higher build number",
      "0.0.24-beta.20261115.3",
      "beta",
      releases,
      newestBeta,
      false,
    ],
    [
      "the newest beta is current on Beta",
      "0.0.24-beta.20261116.2",
      "beta",
      releases,
      "current",
      false,
    ],
    [
      "stable 0.0.24 outranks every 0.0.24 beta",
      "0.0.24-beta.20261116.2",
      "beta",
      [...releases, stable("0.0.24")],
      "v0.0.24",
      false,
    ],
    [
      "a beta install follows Stable onto its own version without the guard",
      "0.0.24-beta.20261116.2",
      "stable",
      [...releases, stable("0.0.24")],
      "v0.0.24",
      false,
    ],
    [
      "Beta 0.0.24 → Stable 0.0.23 is a switch to an older release",
      "0.0.24-beta.20261116.2",
      "stable",
      releases,
      "v0.0.23",
      true,
    ],
    [
      "a withdrawn stable is a downgrade within the line",
      "0.0.24",
      "stable",
      releases,
      "v0.0.23",
      true,
    ],
    [
      "0.0.10 ranks above 0.0.9, numerically",
      "0.0.9",
      "stable",
      [stable("0.0.9"), stable("0.0.10")],
      "v0.0.10",
      false,
    ],
    [
      "a development build is offered the newest release",
      "development",
      "stable",
      releases,
      "v0.0.23",
      false,
    ],
    ["no releases means nothing to offer", "0.0.23", "beta", [], "current", false],
  ] as const)("%s", (_what, installed, line, list, offered, older) => {
    const pick = pickRelease({ releases: list, installed, line });
    if (offered === "current") expect(pick).toEqual({ kind: "current" });
    else expect(pick).toMatchObject({ kind: "offer", release: { tag: offered }, older });
  });

  it.each([
    ["a draft", { ...beta("ace-beta-2026-11-09-0.0.24-1"), draft: true }],
    ["a draft stable", { ...stable("0.0.30"), draft: true }],
    [
      "a preview prerelease",
      { tag: "v0.0.30-preview.1", draft: false, prerelease: true, body: "" },
    ],
    ["a stable tag marked prerelease", { ...stable("0.0.30"), prerelease: true }],
    ["some other tag", { tag: "nightly", draft: false, prerelease: true, body: "" }],
  ])("never counts %s", (_what, release) => {
    expect(
      pickRelease({ releases: [stable("0.0.23"), release], installed: "0.0.23", line: "beta" }),
    ).toEqual({
      kind: "current",
    });
  });

  it("offers a beta under the version its app will report", () => {
    expect(pickRelease({ releases, installed: "0.0.23", line: "beta" })).toMatchObject({
      release: { version: "0.0.24-beta.20261116.2", line: "beta" },
    });
  });

  it("notes every release between the installed one and the offer, newest first", () => {
    const pick = pickRelease({ releases, installed: "0.0.23", line: "beta" });
    expect(pick.kind === "offer" ? pick.notes.map((note) => note.version) : []).toEqual([
      "0.0.24-beta.20261116.2",
      "0.0.24-beta.20261116.1",
      "0.0.24-beta.20261115.3",
    ]);
  });

  it("reads GitHub's list leniently: odd entries are skipped, a missing draft flag is a draft", () => {
    const list = parseReleaseList([
      { tag_name: "v0.0.23", draft: false, prerelease: false, body: "notes", extra: 1 },
      { tag_name: "v0.0.24", prerelease: false },
      { draft: false },
      "junk",
    ]);
    expect(list).toEqual([
      { tag: "v0.0.23", draft: false, prerelease: false, body: "notes" },
      { tag: "v0.0.24", draft: true, prerelease: false, body: "" },
    ]);
    expect(parseReleaseList({ message: "API rate limit exceeded" })).toEqual([]);
  });
});

describe("the guard on switching to an older release", () => {
  const target = { home: 1, daemon: 63, notify: 5, spade: 9 };
  it.each([
    ["the same formats", { home: 1, daemon: 63, notify: 5, spade: 9 }, true],
    ["older formats in the home", { home: 1, daemon: 60, notify: 4, spade: 8 }, true],
    [
      "a database the home doesn't have yet",
      { home: 1, daemon: 63, notify: null, spade: null },
      true,
    ],
    ["a newer daemon schema", { home: 1, daemon: 64, notify: 5, spade: 9 }, false],
    ["a newer home format", { home: 2, daemon: 63, notify: 5, spade: 9 }, false],
    ["a newer notification format", { home: 1, daemon: 63, notify: 6, spade: 9 }, false],
    ["a newer Spade schema", { home: 1, daemon: 63, notify: 5, spade: 10 }, false],
    [
      "a format the release doesn't name",
      { home: 1, daemon: 63, notify: 5, spade: 9, market: 1 },
      false,
    ],
  ])("%s: allowed %s", (_what, home, allowed) => {
    expect(guardSwitch(target, home).ok).toBe(allowed);
  });

  it("blocks when the home has a database its daemon couldn't read, but not one it lacks", () => {
    const unreadSpade = { home: 1, daemon: 63, notify: 5, spade: null, unreadable: ["spade"] };
    expect(guardSwitch(target, unreadSpade)).toEqual({ ok: false, reason: "home-unreadable" });
    expect(guardSwitch(target, { home: 1, daemon: 63, notify: 5, spade: null }).ok).toBe(true);
  });

  it("refuses a release without ace-data.json, and a home nobody has described", () => {
    expect(guardSwitch(undefined, { home: 1, daemon: 1, notify: 1, spade: 1 })).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(guardSwitch(target, undefined)).toEqual({ ok: false, reason: "home-unknown" });
  });

  it("says in one sentence why a beta can't go back to stable yet", () => {
    expect(blockedSentence("newer-data", "beta", "stable")).toBe(
      "Stable can't read this beta's data yet. You can switch once stable reaches a newer release.",
    );
    expect(blockedSentence("unreadable", "beta", "stable")).toBe(
      blockedSentence("newer-data", "beta", "stable"),
    );
  });
});
