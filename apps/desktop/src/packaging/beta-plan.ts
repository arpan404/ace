import {
  betaTag,
  betaTitle,
  betaVersion,
  isStableVersion,
  nextBetaBuild,
  nextPatch,
  parseBetaTag,
  type BetaName,
} from "@ace/service/release-line";
import { isNewer } from "@ace/service/version";

/**
 * What `bun run release:beta` builds and publishes (ADR 0177), as pure decisions. The script
 * (`scripts/release-beta.ts`) is the I/O around them.
 */

/**
 * The hosts a beta is built on, one per release target (ADR 0188): macOS on Apple silicon,
 * Linux x64 and arm64 (each in its own Debian 12 container), and Windows x64.
 */
const betaHosts = new Set(["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]);

/** Why this machine can't build a beta, or undefined when it can. */
export function betaHostProblem(platform: string, arch: string): string | undefined {
  if (betaHosts.has(`${platform}-${arch}`)) return undefined;
  return `Betas are built for ${[...betaHosts].join(", ")}, not ${platform}-${arch}.`;
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
  /** The version the app is built as: `X.Y.Z-beta.<N>`. */
  version: string;
  title: string;
}

/**
 * The next beta (ADR 0177). It previews the next version: the patch after `stable`
 * (`apps/desktop/package.json` at the built commit), or `version` when the person names one,
 * which must be a later X.Y.Z. It is numbered after the highest beta tag GitHub already has for
 * that version.
 */
export function planBeta(input: {
  stable: string;
  version?: string | undefined;
  tags: readonly string[];
}): BetaPlan {
  if (!isStableVersion(input.stable))
    throw new Error(
      `apps/desktop/package.json is at ${input.stable}; a beta builds on a stable X.Y.Z version`,
    );
  const version = input.version ?? nextPatch(input.stable);
  if (!isStableVersion(version)) throw new Error(`--version ${version} is not an X.Y.Z version`);
  if (!isNewer(version, input.stable))
    throw new Error(`--version ${version} must be later than ${input.stable}, the last stable`);
  const name = { version, build: nextBetaBuild(input.tags, version) };
  return { name, tag: betaTag(name), version: betaVersion(name), title: betaTitle(name) };
}

/**
 * The beta a pushed tag names, checked against the rules `planBeta` applies to a new one (ADR
 * 0177): its version must be a later X.Y.Z than `stable`, and its build number must be the one
 * `planBeta` would pick from the tags GitHub had before it. Tags of later builds of that version
 * are left out, so rerunning an older beta's release still checks out.
 */
export function planBetaTag(input: {
  stable: string;
  tag: string;
  tags: readonly string[];
}): BetaPlan {
  const named = parseBetaTag(input.tag);
  if (!named) throw new Error(`${input.tag} is not a beta tag: ace-<X.Y.Z>-beta-<N>`);
  const earlier = input.tags.filter((tag) => {
    const other = parseBetaTag(tag);
    return !other || other.version !== named.version || other.build < named.build;
  });
  const plan = planBeta({ stable: input.stable, version: named.version, tags: earlier });
  if (plan.tag !== input.tag)
    throw new Error(
      `${input.tag} skips a build number: the next beta of ${named.version} is ${plan.tag}`,
    );
  return plan;
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
