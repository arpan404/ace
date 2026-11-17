import type { HomeData, ReleaseData } from "@ace/protocol";
import {
  betaVersion,
  isStableVersion,
  parseBetaTag,
  parseBetaVersion,
  type ReleaseLine,
} from "@ace/service/release-line";

/**
 * Which release the app offers (ADR 0174), as pure decisions over GitHub's release list, the
 * installed version, the person's line and the data their home holds. electron-updater can't
 * pick: its GitHub provider skips tags that aren't semver, and semver ranks a beta of 0.0.23
 * below 0.0.23 itself. The shell (`release-feed.ts`) does the fetching.
 */

/** One release as GitHub's public releases API lists it, read leniently. */
export interface ListedRelease {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  /** The release notes, markdown. */
  body: string;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** `GET /repos/<owner>/<repo>/releases`, keeping only the fields the picker reads. */
export function parseReleaseList(value: unknown): ListedRelease[] {
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const tag = text(Reflect.get(entry, "tag_name"), 200);
    if (!tag) return [];
    return [
      {
        tag,
        draft: Reflect.get(entry, "draft") !== false,
        prerelease: Reflect.get(entry, "prerelease") === true,
        body: text(Reflect.get(entry, "body"), 200_000) ?? "",
      },
    ];
  });
}

/**
 * A release's place in the order `(X.Y.Z, line, date, N)`. Stable ranks below a beta of the same
 * version (line 0 against 1); any other prerelease of that version below both (line -1).
 */
interface Rank {
  core: readonly [number, number, number];
  line: number;
  date: number;
  build: number;
}

export function compareRanks(a: Rank, b: Rank): number {
  for (let index = 0; index < 3; index++) {
    const order = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (order !== 0) return order;
  }
  return a.line - b.line || a.date - b.date || a.build - b.build;
}

function coreOf(version: string): [number, number, number] {
  const [x = 0, y = 0, z = 0] = (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  return [x, y, z];
}

/** Where an app version sits in the order; unknown shapes sit below that version's stable. */
export function versionRank(version: string): Rank {
  const beta = parseBetaVersion(version);
  if (beta)
    return {
      core: coreOf(beta.version),
      line: 1,
      date: Number(beta.date.replaceAll("-", "")),
      build: beta.build,
    };
  return { core: coreOf(version), line: isStableVersion(version) ? 0 : -1, date: 0, build: 0 };
}

/** A release the app could install. */
export interface Candidate {
  tag: string;
  /** The version its app reports: `X.Y.Z`, or `X.Y.Z-beta.<YYYYMMDD>.<N>`. */
  version: string;
  line: ReleaseLine;
  body: string;
}

/**
 * Releases that count: published stable `v<X.Y.Z>` releases and published `ace-beta-…` tags.
 * Drafts never count, nor prereleases under any other tag (previews, release candidates).
 */
export function candidates(releases: readonly ListedRelease[]): Candidate[] {
  return releases.flatMap((release): Candidate[] => {
    if (release.draft) return [];
    const beta = parseBetaTag(release.tag);
    if (beta)
      return [{ tag: release.tag, version: betaVersion(beta), line: "beta", body: release.body }];
    const version = release.tag.startsWith("v") ? release.tag.slice(1) : "";
    if (release.prerelease || !isStableVersion(version)) return [];
    return [{ tag: release.tag, version, line: "stable", body: release.body }];
  });
}

export type Pick =
  /** Nothing on the line is newer, and nothing older to go back to. */
  | { kind: "current" }
  | {
      kind: "offer";
      release: Candidate;
      /** Below the installed version: a switch the downgrade guard must allow first. */
      older: boolean;
      /** What changed: every counted release after the installed one up to this, newest first. */
      notes: { version: string; note: string }[];
    };

/**
 * The release to offer. Stable offers the newest stable release; Beta the newest release of
 * either line, so a beta install moves on to a stable once that is the newest. When that newest
 * release ranks below the installed one (Beta → Stable, or a release withdrawn), it is offered
 * as `older`, for the guard to decide.
 */
export function pickRelease(input: {
  releases: readonly ListedRelease[];
  installed: string;
  line: ReleaseLine;
}): Pick {
  const ranked = candidates(input.releases)
    .filter((release) => input.line === "beta" || release.line === "stable")
    .map((release) => ({ release, rank: versionRank(release.version) }))
    .toSorted((a, b) => compareRanks(b.rank, a.rank));
  const newest = ranked[0];
  if (!newest) return { kind: "current" };
  const installed = versionRank(input.installed);
  const order = compareRanks(newest.rank, installed);
  if (order === 0) return { kind: "current" };
  if (order < 0) return { kind: "offer", release: newest.release, older: true, notes: [] };
  const notes = ranked
    .filter((entry) => compareRanks(entry.rank, installed) > 0)
    .map(({ release }) => ({ version: release.version, note: release.body }));
  return { kind: "offer", release: newest.release, older: false, notes };
}

export type Guard =
  | { ok: true }
  /**
   * `unreadable`: the release publishes no `ace-data.json` (or one that can't be read).
   * `home-unknown`: the daemon hasn't said what the home holds. `newer-data`: the home holds a
   * format newer than the release reads.
   */
  | { ok: false; reason: "unreadable" | "home-unknown" | "newer-data" };

/**
 * Whether an older release can read the home (ADR 0174): every format the home holds must be at
 * most the number in the release's `ace-data.json`. A format the home doesn't have yet (null)
 * never blocks; one the release doesn't name always does.
 */
export function guardSwitch(target: ReleaseData | undefined, home: HomeData | undefined): Guard {
  if (!target) return { ok: false, reason: "unreadable" };
  if (!home) return { ok: false, reason: "home-unknown" };
  for (const [name, held] of Object.entries(home)) {
    if (typeof held !== "number") continue;
    const reads: unknown = Reflect.get(target, name);
    if (typeof reads !== "number" || reads < held) return { ok: false, reason: "newer-data" };
  }
  return { ok: true };
}

/** The one sentence Settings shows when the guard keeps ace where it is. */
export function blockedSentence(
  reason: "unreadable" | "home-unknown" | "newer-data",
  from: ReleaseLine,
  to: ReleaseLine,
): string {
  if (reason === "home-unknown")
    return "ace can't switch yet: its daemon hasn't said which data this install holds.";
  if (from === "beta" && to === "stable")
    return "Stable can't read this beta's data yet. You can switch once stable reaches a newer release.";
  return "The release on offer can't read this install's data, so ace stays on this version.";
}
