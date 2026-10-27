import * as z from "zod/mini";

/*
 * Which installer fits which computer, decided from GitHub's "latest release" answer. Shared by
 * the build (release.ts, for links that work without JavaScript) and the visitor's browser
 * (scripts/latest-release.ts, which re-checks the newest release and their chip). Pure, and
 * uses zod/mini so the browser bundle stays small.
 */

export type Platform = "mac" | "windows" | "linux";
export type Arch = "arm64" | "x64";

export const platforms: readonly Platform[] = ["mac", "windows", "linux"];

/** The build most people on each system need, when their chip can't be told. */
export const defaultArch: Record<Platform, Arch> = { mac: "arm64", windows: "x64", linux: "x64" };

export const platformInfo: Record<Platform, { name: string; builds: Record<Arch, string> }> = {
  mac: { name: "Mac", builds: { arm64: "macOS on Apple silicon", x64: "macOS on Intel" } },
  windows: { name: "Windows", builds: { x64: "Windows on x64", arm64: "Windows on Arm" } },
  linux: {
    name: "Linux",
    builds: { x64: "Linux on x64 (AppImage)", arm64: "Linux on Arm64 (AppImage)" },
  },
};

/* The release's file names (apps/desktop/scripts/package.ts): one per system and chip. */
const installer: Record<Platform, (arch: Arch) => string> = {
  mac: (arch) => `-${arch}.dmg`,
  windows: (arch) => `-${arch}-setup.exe`,
  linux: (arch) => `-${arch}.AppImage`,
};

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  published_at: z.nullable(z.string()),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      browser_download_url: z.url(),
    }),
  ),
});

export type Release = z.infer<typeof releaseSchema>;

/** A published release from GitHub's answer; throws with the reason for anything else. */
export function readRelease(body: unknown): Release {
  const release = releaseSchema.parse(body);
  if (release.draft || release.prerelease) throw new Error(`${release.tag_name} isn't published`);
  return release;
}

export interface Pick {
  /** The installer itself, or the release page when the release has none for this computer. */
  url: string;
  /** Installer size in bytes, when the installer was found. */
  bytes: number | undefined;
}

/**
 * The installer for one system and chip. Never a different chip's build, which wouldn't run:
 * without a match, the release page, where every build is listed.
 */
export function pickInstaller(release: Release, platform: Platform, arch: Arch): Pick {
  const suffix = installer[platform](arch);
  const asset = release.assets.find((candidate) => candidate.name.endsWith(suffix));
  return asset
    ? { url: asset.browser_download_url, bytes: asset.size }
    : { url: release.html_url, bytes: undefined };
}

export function versionOf(release: Release): string {
  return release.tag_name.replace(/^v/, "");
}

/** "215 MB" */
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** "macOS on Apple silicon, 228 MB" */
export function buildText(platform: Platform, arch: Arch, bytes: number | undefined): string {
  const build = platformInfo[platform].builds[arch];
  return bytes ? `${build}, ${formatSize(bytes)}` : build;
}

/** "v0.0.11 for macOS on Apple silicon, 228 MB." */
export function noteText(
  version: string | undefined,
  platform: Platform,
  arch: Arch,
  bytes: number | undefined,
): string {
  return `${version ? `v${version} for ` : ""}${buildText(platform, arch, bytes)}. `;
}

/** The download link's spoken name: the visible words, then what the note shows sighted readers. */
export function labelText(
  version: string | undefined,
  platform: Platform,
  arch: Arch,
  bytes: number | undefined,
): string {
  const { name, builds } = platformInfo[platform];
  if (!bytes) return `Download for ${name} (latest release page)`;
  return `Download for ${name} (ace ${version}, ${builds[arch]}, ${formatSize(bytes)})`;
}

/** Narrows a data attribute to a platform name. */
export function isPlatform(value: string | undefined): value is Platform {
  return value === "mac" || value === "windows" || value === "linux";
}
