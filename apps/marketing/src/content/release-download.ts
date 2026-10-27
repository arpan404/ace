import {
  defaultArch,
  pickInstaller,
  readRelease,
  versionOf,
  type Pick,
  type Platform,
} from "./release-pick.ts";

/*
 * The downloads the build bakes into the page, for each system's usual chip (defaultArch). They
 * work without JavaScript; in the browser, scripts/latest-release.ts re-picks from the newest
 * release and the visitor's own chip. Pure; release.ts does the fetching.
 */

export interface Downloads {
  /** "0.0.7", when the release was found. */
  version: string | undefined;
  /** The release page with its notes. */
  notesUrl: string;
  publishedAt: string | undefined;
  byPlatform: Record<Platform, Pick>;
}

/** Every link opens the latest release page: used whenever the release can't be read. */
export function releasePageDownloads(latestReleasePage: string): Downloads {
  const page: Pick = { url: latestReleasePage, bytes: undefined };
  return {
    version: undefined,
    notesUrl: latestReleasePage,
    publishedAt: undefined,
    byPlatform: { mac: page, windows: page, linux: page },
  };
}

/**
 * Each system's installer from a published release; a system it has none for gets the release
 * page. Throws with the reason when the answer isn't a usable release, so the caller can fall
 * back and say why.
 */
export function downloadsFromRelease(body: unknown): Downloads {
  const release = readRelease(body);
  const pick = (platform: Platform) => pickInstaller(release, platform, defaultArch[platform]);
  return {
    version: versionOf(release),
    notesUrl: release.html_url,
    publishedAt: release.published_at ?? undefined,
    byPlatform: { mac: pick("mac"), windows: pick("windows"), linux: pick("linux") },
  };
}
