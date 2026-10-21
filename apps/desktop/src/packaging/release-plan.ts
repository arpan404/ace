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
 */
export function desktopAssets(names: readonly string[], version: string): string[] {
  const packages = new RegExp(
    `^ace-${version.replaceAll(".", "\\.")}(-[A-Za-z0-9_]+)*\\.(dmg|zip|exe|AppImage|deb)(\\.blockmap)?$`,
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

/** The macOS update feed needs the zip: Squirrel.Mac installs from it, never the dmg. */
export function missingUpdatePackages(assets: readonly string[]): string[] {
  const missing: string[] = [];
  const mac = assets.some((name) => name.endsWith("-mac.yml"));
  if (mac && !assets.some((name) => name.endsWith("-mac.zip"))) missing.push("macOS zip");
  return missing;
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
