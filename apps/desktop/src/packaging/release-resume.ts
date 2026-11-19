import { z } from "zod";
import { checksumList, combineStaged, type StagedRelease } from "./release-plan.ts";

/**
 * Where a tag's release stands and what a run still has to do (ADR 0188), as pure decisions
 * over what GitHub already holds. A rerun of the pipeline reads the same facts and continues
 * where the last run stopped: platforms already uploaded to the draft are not rebuilt, and a
 * published release is left alone.
 *
 * Each build host's staged folder is uploaded to the tag's draft release with its manifest as
 * `staged-<platform>.json` (the host's `release.json`). Publishing combines those manifests.
 */

/** Every platform a release ships, beta and stable alike. */
export const releasePlatforms = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"] as const;
export type ReleasePlatform = (typeof releasePlatforms)[number];

export function manifestAsset(platform: ReleasePlatform): string {
  return `staged-${platform}.json`;
}

export function isManifestAsset(name: string): boolean {
  return releasePlatforms.some((platform) => manifestAsset(platform) === name);
}

/** A release asset as `gh release view --json assets` reports it; `digest` is `sha256:<hex>`. */
export const ReleaseAsset = z.looseObject({
  name: z.string(),
  size: z.number(),
  digest: z.string().nullish(),
});
export type ReleaseAsset = z.infer<typeof ReleaseAsset>;

/** The tag's GitHub release, or none yet. */
export type ReleaseState =
  | { exists: false }
  | { exists: true; draft: boolean; body: string; assets: readonly ReleaseAsset[] };

function sha256Of(asset: ReleaseAsset): string | undefined {
  return asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : undefined;
}

/**
 * Staged files the release lacks or holds with other bytes. A size that differs, or a digest
 * GitHub reports that differs, counts; a missing digest is trusted on size alone.
 */
export function missingAssets(
  assets: readonly ReleaseAsset[],
  staged: Pick<StagedRelease, "files">,
): string[] {
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  return staged.files
    .filter((file) => {
      const asset = byName.get(file.name);
      if (!asset || asset.size !== file.bytes) return true;
      const digest = sha256Of(asset);
      return digest !== undefined && digest !== file.sha256;
    })
    .map((file) => file.name);
}

/** A file this host would upload that the release already holds with other bytes. */
export function conflictingAssets(
  assets: readonly ReleaseAsset[],
  staged: Pick<StagedRelease, "files">,
): string[] {
  const present = new Set(assets.map((asset) => asset.name));
  return missingAssets(assets, staged).filter((name) => present.has(name));
}

export interface ResumePlan {
  /** The release is published: nothing to build, upload or publish. */
  published: boolean;
  /** Platforms whose files aren't all on the draft yet, from the tag's commit. */
  build: ReleasePlatform[];
}

/**
 * What this run builds. `manifests` holds the staged manifest each platform already uploaded.
 * A platform is done when its manifest is from the tag's commit and every file it lists is on
 * the draft with the recorded bytes.
 */
export function resumePlan(input: {
  state: ReleaseState;
  commit: string;
  manifests: ReadonlyMap<ReleasePlatform, StagedRelease>;
}): ResumePlan {
  const { state } = input;
  if (state.exists && !state.draft) return { published: true, build: [] };
  const assets = state.exists ? state.assets : [];
  const build = releasePlatforms.filter((platform) => {
    const manifest = input.manifests.get(platform);
    if (!manifest || manifest.commit !== input.commit) return true;
    return missingAssets(assets, manifest).length > 0;
  });
  return { published: false, build };
}

export type PublishVerdict =
  | { ok: true; release: StagedRelease; checksums: string }
  | { ok: false; problems: string[] };

/**
 * Whether the draft can go live: every platform uploaded, all from the tag's commit and
 * version, none built with uncommitted changes, the macOS build signed and notarized, and
 * every listed file on the draft with its recorded bytes. Returns the combined release and its
 * `SHA256SUMS`.
 */
export function publishVerdict(input: {
  assets: readonly ReleaseAsset[];
  commit: string;
  version: string;
  manifests: ReadonlyMap<ReleasePlatform, StagedRelease>;
}): PublishVerdict {
  const problems: string[] = [];
  const missing = releasePlatforms.filter((platform) => !input.manifests.has(platform));
  if (missing.length) problems.push(`No build uploaded for ${missing.join(", ")}`);
  for (const [platform, manifest] of input.manifests) {
    if (manifest.commit !== input.commit)
      problems.push(
        `${platform} was built from ${manifest.commit.slice(0, 12)}, not the tag's commit`,
      );
    if (manifest.version !== input.version)
      problems.push(`${platform} was built as ${manifest.version}, not ${input.version}`);
    if (manifest.dirty) problems.push(`${platform} was built with uncommitted changes`);
  }
  const mac = input.manifests.get("darwin-arm64");
  if (mac && !(mac.signed && mac.notarized))
    problems.push("The macOS build isn't signed and notarized");
  if (problems.length) return { ok: false, problems };
  let release: StagedRelease;
  try {
    release = combineStaged([...input.manifests.values()]);
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
  const absent = missingAssets(input.assets, release);
  if (absent.length) return { ok: false, problems: [`Not on the draft: ${absent.join(", ")}`] };
  return { ok: true, release, checksums: checksumList(release) };
}
