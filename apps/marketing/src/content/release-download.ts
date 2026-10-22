import { z } from "zod";

/*
 * Which file "Download for Mac" points at, decided from GitHub's "latest release" answer. Pure,
 * so the rules are tested without the network; release.ts does the fetching.
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

export interface Download {
  /** Where "Download for Mac" points: the disk image itself, or the release page as a fallback. */
  url: string;
  /** "0.0.7", when the release was found. */
  version: string | undefined;
  /** The release page with its notes. */
  notesUrl: string;
  /** Disk image size in bytes, when known. */
  bytes: number | undefined;
  publishedAt: string | undefined;
}

/** Every link opens the latest release page: used whenever the disk image can't be named. */
export function releasePageDownload(latestReleasePage: string): Download {
  return {
    url: latestReleasePage,
    version: undefined,
    notesUrl: latestReleasePage,
    bytes: undefined,
    publishedAt: undefined,
  };
}

/**
 * The Apple-silicon disk image of a published release. Throws with the reason when the answer
 * isn't a usable release, so the caller can fall back and say why.
 */
export function downloadFromRelease(body: unknown): Download {
  const release = releaseSchema.parse(body);
  if (release.draft || release.prerelease) throw new Error(`${release.tag_name} isn't published`);
  const dmg = release.assets.find((asset) => asset.name.endsWith("-arm64.dmg"));
  if (!dmg) throw new Error(`${release.tag_name} has no Apple-silicon disk image`);
  return {
    url: dmg.browser_download_url,
    version: release.tag_name.replace(/^v/, ""),
    notesUrl: release.html_url,
    bytes: dmg.size,
    publishedAt: release.published_at ?? undefined,
  };
}

/** "215 MB" */
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
