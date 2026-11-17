import {
  betaDate,
  betaTag,
  betaTitle,
  betaVersion,
  isStableVersion,
  nextBetaBuild,
  parseBetaTag,
  type BetaName,
} from "@ace/service/release-line";

/**
 * What `bun run release:beta` builds and publishes (ADR 0174), as pure decisions. The script
 * (`scripts/release-beta.ts`) is the I/O around them.
 */

/** Why this machine can't build a beta, or undefined when it can: macOS on Apple silicon only. */
export function betaHostProblem(platform: string, arch: string): string | undefined {
  if (platform === "darwin" && arch === "arm64") return undefined;
  return `Betas are built for macOS on Apple silicon only, not ${platform}-${arch}.`;
}

/** Tag names from `git ls-remote --tags`, without the peeled `^{}` duplicates. */
export function remoteTagNames(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (!ref?.startsWith("refs/tags/")) continue;
    names.add(ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""));
  }
  return [...names];
}

export interface BetaPlan {
  name: BetaName;
  tag: string;
  /** The version the app is built as: `X.Y.Z-beta.<YYYYMMDD>.<N>`. */
  version: string;
  title: string;
}

/**
 * The next beta of the stable `version` (`apps/desktop/package.json` at the built commit),
 * dated `now` in UTC, numbered after the beta tags GitHub already has.
 */
export function planBeta(input: {
  version: string;
  now: number;
  tags: readonly string[];
}): BetaPlan {
  if (!isStableVersion(input.version))
    throw new Error(
      `apps/desktop/package.json is at ${input.version}; a beta builds on a stable X.Y.Z version`,
    );
  const date = betaDate(input.now);
  const name = {
    date,
    version: input.version,
    build: nextBetaBuild(input.tags, date, input.version),
  };
  return { name, tag: betaTag(name), version: betaVersion(name), title: betaTitle(name) };
}

/**
 * The staged beta to publish from the folders under `dist/releases`: the one named, or the only
 * one staged. Several staged betas need the tag named, so the wrong one is never published.
 */
export function stagedBeta(folders: readonly string[], wanted: string | undefined): string {
  const betas = folders.filter((folder) => parseBetaTag(folder) !== undefined).toSorted();
  if (wanted !== undefined) {
    if (!parseBetaTag(wanted)) throw new Error(`${wanted} is not a beta tag`);
    if (!betas.includes(wanted))
      throw new Error(`Nothing staged for ${wanted}: run bun run release:beta build first.`);
    return wanted;
  }
  const [only, ...others] = betas;
  if (!only) throw new Error("No beta is staged: run bun run release:beta build first.");
  if (others.length) throw new Error(`Several betas are staged; name one: ${betas.join(", ")}`);
  return only;
}
