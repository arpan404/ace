import { z } from "zod";
import type { ReleaseTarget } from "@ace/protocol";

/**
 * What a desktop release publishes (ADR 0091), as pure decisions over file names and
 * recorded hashes. `scripts/release.ts` is the I/O around it.
 */

export const releaseRepository = "arpan404/ace";

export function releaseTag(version: string): string {
  return `v${version}`;
}

/** A version with a prerelease part (`1.2.0-preview.1`) is published as a prerelease. */
export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/**
 * The files of electron-builder's output folder that a release publishes: this version's
 * packages and their blockmaps, and the update feed (`latest-mac.yml`, `latest-linux.yml`,
 * a preview channel's `preview-mac.yml` …). Its own logs (`builder-debug.yml`,
 * `builder-effective-config.yaml`), unpacked app folders and other versions stay behind.
 * Linux ships an AppImage (updates itself from `latest-linux*.yml`), a deb and a tar.gz
 * (both offered the release page when an update exists; ADR 0093).
 */
export function desktopAssets(names: readonly string[], version: string): string[] {
  const packages = new RegExp(
    `^ace-${version.replaceAll(".", "\\.")}(-[A-Za-z0-9_]+)*\\.(dmg|zip|exe|AppImage|deb|tar\\.gz)(\\.blockmap)?$`,
  );
  const feed = /^[a-z]+(-mac|-linux(-arm64)?)?\.yml$/;
  return names.filter((name) => packages.test(name) || feed.test(name)).toSorted();
}

/**
 * Complete standalone update sets for the targets rebuilt by this release. Other targets'
 * versionless manifests may be left over in the shared output folder (ADR 0041).
 */
export function daemonAssets(
  names: readonly string[],
  version: string,
  targets: readonly z.infer<typeof ReleaseTarget>[],
): string[] {
  const available = new Set(names);
  const files = targets.flatMap((target) => [
    `${target}.json`,
    `${target}.sig`,
    `ace-${version}-${target}.tar.gz`,
  ]);
  const missing = files.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`Missing daemon release files: ${missing.join(", ")}`);
  return files.toSorted();
}

/**
 * Each feed needs the package its updater installs: Squirrel.Mac the zip (never the dmg),
 * a Linux AppImage the AppImage (a deb or tar.gz is never installed by the updater).
 */
export function missingUpdatePackages(assets: readonly string[]): string[] {
  const missing: string[] = [];
  const mac = assets.some((name) => name.endsWith("-mac.yml"));
  if (mac && !assets.some((name) => name.endsWith("-mac.zip"))) missing.push("macOS zip");
  const linux = assets.some((name) => /-linux(-arm64)?\.yml$/.test(name));
  if (linux && !assets.some((name) => name.endsWith(".AppImage"))) missing.push("Linux AppImage");
  return missing;
}

/**
 * The standalone daemon archives a release built on this host can include. A Mac builds both
 * macOS targets; Linux natives (node-pty, the workspace addon, the screen helper) are built on
 * a host of the target architecture, so a Linux host builds only its own target.
 */
export function daemonTargetsFor(
  platform: NodeJS.Platform,
  arch: string,
): z.infer<typeof ReleaseTarget>[] {
  if (platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return [`linux-${arch}`];
  throw new Error(`No standalone daemon release is built on ${platform}-${arch}`);
}

export const StagedRelease = z.object({
  version: z.string(),
  tag: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Built with uncommitted changes (`--allow-dirty`): a trial, never published. */
  dirty: z.boolean(),
  signed: z.boolean(),
  notarized: z.boolean(),
  files: z.array(
    z.object({
      name: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});
export type StagedRelease = z.infer<typeof StagedRelease>;

/**
 * One release from the staged folders of several hosts (this Mac, a Linux container for each
 * architecture): all must be the same version built from the same commit, none with
 * uncommitted changes, and no file may appear twice. Signed only if every part was.
 */
export function combineStaged(releases: readonly StagedRelease[]): StagedRelease {
  const [first, ...others] = releases;
  if (!first) throw new Error("Nothing staged to publish");
  for (const other of others) {
    if (other.version !== first.version || other.tag !== first.tag)
      throw new Error(
        `Staged builds are for different versions: ${first.version}, ${other.version}`,
      );
    if (other.commit !== first.commit)
      throw new Error(
        `Staged builds come from different commits: ${first.commit.slice(0, 12)}, ${other.commit.slice(0, 12)}`,
      );
  }
  const files = releases.flatMap((release) => release.files);
  const seen = new Set<string>();
  const duplicates = files.filter((file) => seen.size === seen.add(file.name).size);
  if (duplicates.length)
    throw new Error(`Staged in more than one build: ${duplicates.map((f) => f.name).join(", ")}`);
  return {
    ...first,
    dirty: releases.some((release) => release.dirty),
    signed: releases.every((release) => release.signed),
    notarized: releases.every((release) => release.notarized),
    files: files.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

/** `sha256sum`-style lines for the staged files, published as `SHA256SUMS`. */
export function checksumList(release: StagedRelease): string {
  return release.files.map((file) => `${file.sha256}  ${file.name}\n`).join("");
}

/** Staged files whose bytes no longer match what the build recorded. */
export function changedFiles(
  release: StagedRelease,
  actual: ReadonlyMap<string, string | undefined>,
): string[] {
  return release.files
    .filter((file) => actual.get(file.name) !== file.sha256)
    .map((file) => file.name);
}
