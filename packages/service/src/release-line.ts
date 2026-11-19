/**
 * ace's two release lines and the names a beta goes by (ADR 0177). Pure: no clock, no I/O.
 *
 * - Tag: `ace-<X.Y.Z>-beta-<N>`, e.g. `ace-0.0.24-beta-1`.
 * - Version inside the app: `X.Y.Z-beta.<N>`, e.g. `0.0.24-beta.1`.
 * - Title: `ace 0.0.24 beta 1`.
 *
 * `X.Y.Z` is the next version, the one the beta previews: by default the patch after
 * `apps/desktop/package.json` at the built commit (0.0.23 → 0.0.24). `N` counts that version's
 * betas from 1, across days. Semver then orders every release, the build number numerically:
 * 0.0.23 < 0.0.24-beta.1 < 0.0.24-beta.2 < 0.0.24-beta.10 < 0.0.24.
 */

export type ReleaseLine = "stable" | "beta";

export interface BetaName {
  /** The version the beta previews, `X.Y.Z`: the next stable release. */
  version: string;
  /** One more than the highest build already tagged for this version; from 1. */
  build: number;
}

const part = "(?:0|[1-9]\\d{0,8})";
const core = `${part}\\.${part}\\.${part}`;
const build = "[1-9]\\d{0,5}";
const tagPattern = new RegExp(`^ace-(${core})-beta-(${build})$`);
const versionPattern = new RegExp(`^(${core})-beta\\.(${build})$`);
const stablePattern = new RegExp(`^${core}$`);

function named(match: RegExpExecArray | null): BetaName | undefined {
  if (!match) return undefined;
  const [, version = "", n = ""] = match;
  return { version, build: Number(n) };
}

/** The beta a tag names (`ace-0.0.24-beta-1`), or undefined for any other tag. */
export function parseBetaTag(tag: string): BetaName | undefined {
  return named(tagPattern.exec(tag));
}

/** The beta an app version names (`0.0.24-beta.1`), or undefined. */
export function parseBetaVersion(value: string): BetaName | undefined {
  return named(versionPattern.exec(value));
}

function checked(name: BetaName): BetaName {
  if (
    !stablePattern.test(name.version) ||
    !Number.isInteger(name.build) ||
    name.build < 1 ||
    name.build > 999_999
  )
    throw new Error(`Not a beta: ${JSON.stringify(name)}`);
  return name;
}

export function betaTag(name: BetaName): string {
  const { version, build: n } = checked(name);
  return `ace-${version}-beta-${n}`;
}

export function betaVersion(name: BetaName): string {
  const { version, build: n } = checked(name);
  return `${version}-beta.${n}`;
}

export function betaTitle(name: BetaName): string {
  const { version, build: n } = checked(name);
  return `ace ${version} beta ${n}`;
}

/**
 * The build number for the next beta of `version`: one more than the highest number among
 * existing tags of that version, so a gap left by a removed tag is never reused.
 */
export function nextBetaBuild(tags: readonly string[], version: string): number {
  let highest = 0;
  for (const tag of tags) {
    const beta = parseBetaTag(tag);
    if (beta && beta.version === version) highest = Math.max(highest, beta.build);
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
