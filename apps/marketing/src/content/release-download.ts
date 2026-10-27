import { z } from "zod";

/*
 * Which file each "Download" button points at, decided from GitHub's "latest release" answer.
 * Pure, so the rules are tested without the network; release.ts does the fetching.
 */

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  published_at: z.string().nullable(),
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

export type Platform = "mac" | "windows" | "linux";

export const platforms: readonly Platform[] = ["mac", "windows", "linux"];

/** How each platform is named on a button, and which build the site offers for it. */
export const platformInfo: Record<Platform, { name: string; build: string; file: RegExp }> = {
  mac: { name: "Mac", build: "macOS on Apple silicon", file: /-arm64\.dmg$/ },
  windows: { name: "Windows", build: "Windows on x64", file: /-x64-setup\.exe$/ },
  linux: { name: "Linux", build: "Linux on x64 (AppImage)", file: /-x64\.AppImage$/ },
};

export interface PlatformDownload {
  /** The installer itself, or the release page when this release has none for the platform. */
  url: string;
  /** Installer size in bytes, when the installer was found. */
  bytes: number | undefined;
}

export interface Downloads {
  /** "0.0.7", when the release was found. */
  version: string | undefined;
  /** The release page with its notes. */
  notesUrl: string;
  publishedAt: string | undefined;
  byPlatform: Record<Platform, PlatformDownload>;
}

/** Every link opens the latest release page: used whenever the release can't be read. */
export function releasePageDownloads(latestReleasePage: string): Downloads {
  const page: PlatformDownload = { url: latestReleasePage, bytes: undefined };
  return {
    version: undefined,
    notesUrl: latestReleasePage,
    publishedAt: undefined,
    byPlatform: { mac: page, windows: page, linux: page },
  };
}

/**
 * Each platform's installer from a published release. A platform the release has no installer
 * for gets the release page. Throws with the reason when the answer isn't a usable release, so
 * the caller can fall back and say why.
 */
export function downloadsFromRelease(body: unknown): Downloads {
  const release = releaseSchema.parse(body);
  if (release.draft || release.prerelease) throw new Error(`${release.tag_name} isn't published`);
  const pick = (platform: Platform): PlatformDownload => {
    const asset = release.assets.find((candidate) =>
      platformInfo[platform].file.test(candidate.name),
    );
    return asset
      ? { url: asset.browser_download_url, bytes: asset.size }
      : { url: release.html_url, bytes: undefined };
  };
  return {
    version: release.tag_name.replace(/^v/, ""),
    notesUrl: release.html_url,
    publishedAt: release.published_at ?? undefined,
    byPlatform: { mac: pick("mac"), windows: pick("windows"), linux: pick("linux") },
  };
}

/** "215 MB" */
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
