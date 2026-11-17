import { ReleaseVersion, type HomeData, type ReleaseData } from "@ace/protocol";
import {
  betaVersion,
  isStableVersion,
  parseBetaTag,
  type ReleaseLine,
} from "@ace/service/release-line";
import { isNewer } from "@ace/service/version";

/**
 * Which release the app offers (ADR 0174), as pure decisions over GitHub's release list, the
 * installed version, the person's line and the data their home holds. electron-updater can't
 * pick: its GitHub provider skips tags that aren't semver (`ace-beta-…`). Releases order by
 * semver; a beta carries the next version. The shell (`release-feed.ts`) does the fetching.
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
 * Semver order (ADR 0174): a beta carries the next version, with its date and build number in
 * the prerelease part, so 0.0.23 < 0.0.24-beta.20261116.1 < 0.0.24-beta.20261116.2 < 0.0.24.
 * A version that isn't semver (a development build) sorts below every release.
 */
const valid = (version: string) => ReleaseVersion.safeParse(version).success;

export function compareVersions(a: string, b: string): number {
  if (!valid(a) || !valid(b)) return Number(valid(a)) - Number(valid(b));
  return isNewer(a, b) ? 1 : isNewer(b, a) ? -1 : 0;
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
 * either line, so a beta install moves on to its version's stable once that ships. When that
 * newest release ranks below the installed one (Beta 0.0.24-beta.* → Stable 0.0.23, or a
 * release withdrawn), it is offered as `older`, for the guard to decide.
 */
export function pickRelease(input: {
  releases: readonly ListedRelease[];
  installed: string;
  line: ReleaseLine;
}): Pick {
  const ranked = candidates(input.releases)
    .filter((release) => input.line === "beta" || release.line === "stable")
    .toSorted((a, b) => compareVersions(b.version, a.version));
  const newest = ranked[0];
  if (!newest) return { kind: "current" };
  const order = compareVersions(newest.version, input.installed);
  if (order === 0) return { kind: "current" };
  if (order < 0) return { kind: "offer", release: newest, older: true, notes: [] };
  const notes = ranked
    .filter((release) => compareVersions(release.version, input.installed) > 0)
    .map((release) => ({ version: release.version, note: release.body }));
  return { kind: "offer", release: newest, older: false, notes };
}

export type Guard =
  | { ok: true }
  /**
   * `unreadable`: the release publishes no `ace-data.json` (or one that can't be read).
   * `home-unknown`: the daemon hasn't said what the home holds. `home-unreadable`: a file the
   * home has couldn't be read, so its version is unknown. `newer-data`: the home holds a format
   * newer than the release reads.
   */
  | { ok: false; reason: GuardReason };

export type GuardReason = "unreadable" | "home-unknown" | "home-unreadable" | "newer-data";

/**
 * Whether an older release can read the home (ADR 0174): every format the home holds must be at
 * most the number in the release's `ace-data.json`. A format the home doesn't have yet (null)
 * never blocks; one the daemon couldn't read, or the release doesn't name, always does.
 */
export function guardSwitch(target: ReleaseData | undefined, home: HomeData | undefined): Guard {
  if (!target) return { ok: false, reason: "unreadable" };
  if (!home) return { ok: false, reason: "home-unknown" };
  if (home.unreadable?.length) return { ok: false, reason: "home-unreadable" };
  for (const [name, held] of Object.entries(home)) {
    if (name === "unreadable" || typeof held !== "number") continue;
    const reads: unknown = Reflect.get(target, name);
    if (typeof reads !== "number" || reads < held) return { ok: false, reason: "newer-data" };
  }
  return { ok: true };
}

/** The one sentence Settings shows when the guard keeps ace where it is. */
export function blockedSentence(reason: GuardReason, from: ReleaseLine, to: ReleaseLine): string {
  if (reason === "home-unknown")
    return "ace can't switch yet: its daemon hasn't said which data this install holds.";
  if (reason === "home-unreadable")
    return "ace can't switch yet: it couldn't read which data this install holds. It tries again at the next check.";
  if (from === "beta" && to === "stable")
    return "Stable can't read this beta's data yet. You can switch once stable reaches a newer release.";
  return "The release on offer can't read this install's data, so ace stays on this version.";
}
