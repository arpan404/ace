/**
 * ace's two release lines and the names a beta goes by (ADR 0174). Pure: no clock, no I/O.
 *
 * - Tag: `ace-beta-<YYYY-MM-DD>-<X.Y.Z>-<N>`, e.g. `ace-beta-2026-11-16-0.0.24-1`.
 * - Version inside the app: `X.Y.Z-beta.<YYYYMMDD>.<N>`, e.g. `0.0.24-beta.20261116.1`.
 * - Title: `ace beta 2026-11-16 (0.0.24, build 1)`.
 *
 * `X.Y.Z` is the next version, the one the beta previews: by default the patch after
 * `apps/desktop/package.json` at the built commit (0.0.23 → 0.0.24). The date is the build date
 * in UTC and `N` counts that date's betas of that version from 1. Semver then orders every
 * release: 0.0.23 < 0.0.24-beta.20261116.1 < 0.0.24-beta.20261116.2 < 0.0.24.
 */

export type ReleaseLine = "stable" | "beta";

export interface BetaName {
  /** The build date in UTC, `YYYY-MM-DD`. */
  date: string;
  /** The version the beta previews, `X.Y.Z`: the next stable release. */
  version: string;
  /** One more than the betas already tagged with this date and version; from 1. */
  build: number;
}

const part = "(?:0|[1-9]\\d{0,8})";
const core = `${part}\\.${part}\\.${part}`;
const build = "[1-9]\\d{0,5}";
const tagPattern = new RegExp(`^ace-beta-(\\d{4})-(\\d{2})-(\\d{2})-(${core})-(${build})$`);
const versionPattern = new RegExp(`^(${core})-beta\\.(\\d{4})(\\d{2})(\\d{2})\\.(${build})$`);
const stablePattern = new RegExp(`^${core}$`);

/** A real calendar date, so `2026-02-30` is no beta's. */
function calendarDate(year: string, month: string, day: string): string | undefined {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const time = new Date(Date.UTC(y, m - 1, d));
  if (time.getUTCFullYear() !== y || time.getUTCMonth() !== m - 1 || time.getUTCDate() !== d)
    return undefined;
  return `${year}-${month}-${day}`;
}

function named(date: string | undefined, version: string, n: string): BetaName | undefined {
  return date === undefined ? undefined : { date, version, build: Number(n) };
}

/** The beta a tag names, or undefined for any other tag. */
export function parseBetaTag(tag: string): BetaName | undefined {
  const match = tagPattern.exec(tag);
  if (!match) return undefined;
  const [, year = "", month = "", day = "", version = "", n = ""] = match;
  return named(calendarDate(year, month, day), version, n);
}

/** The beta an app version names (`0.0.23-beta.20261103.1`), or undefined. */
export function parseBetaVersion(value: string): BetaName | undefined {
  const match = versionPattern.exec(value);
  if (!match) return undefined;
  const [, version = "", year = "", month = "", day = "", n = ""] = match;
  return named(calendarDate(year, month, day), version, n);
}

function checked(name: BetaName): BetaName {
  const [year = "", month = "", day = ""] = name.date.split("-");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(name.date) ||
    calendarDate(year, month, day) === undefined ||
    !stablePattern.test(name.version) ||
    !Number.isInteger(name.build) ||
    name.build < 1 ||
    name.build > 999_999
  )
    throw new Error(`Not a beta: ${JSON.stringify(name)}`);
  return name;
}

export function betaTag(name: BetaName): string {
  const { date, version, build: n } = checked(name);
  return `ace-beta-${date}-${version}-${n}`;
}

export function betaVersion(name: BetaName): string {
  const { date, version, build: n } = checked(name);
  return `${version}-beta.${date.replaceAll("-", "")}.${n}`;
}

export function betaTitle(name: BetaName): string {
  const { date, version, build: n } = checked(name);
  return `ace beta ${date} (${version}, build ${n})`;
}

/** The UTC date of `time`, as a beta tag spells it. */
export function betaDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The build number for the next beta of `version` on `date`: one more than the highest number
 * among existing tags with that date and version, so a gap left by a removed tag is never reused.
 */
export function nextBetaBuild(tags: readonly string[], date: string, version: string): number {
  let highest = 0;
  for (const tag of tags) {
    const beta = parseBetaTag(tag);
    if (beta && beta.date === date && beta.version === version)
      highest = Math.max(highest, beta.build);
  }
  return highest + 1;
}

/** The patch after a stable version: the version a beta previews by default (0.0.23 → 0.0.24). */
export function nextPatch(version: string): string {
  if (!stablePattern.test(version)) throw new Error(`${version} is not a stable X.Y.Z version`);
  const [x, y, z = "0"] = version.split(".");
  return `${x}.${y}.${Number(z) + 1}`;
}

/** Whether `version` is a plain stable version, `X.Y.Z`. */
export function isStableVersion(value: string): boolean {
  return stablePattern.test(value);
}

/** The line an app or daemon version belongs to: beta for a beta's version, else stable. */
export function releaseLineOf(version: string): ReleaseLine {
  return parseBetaVersion(version) ? "beta" : "stable";
}
