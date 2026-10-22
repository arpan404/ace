import { links, repository } from "../site.ts";
import { downloadFromRelease, releasePageDownload, type Download } from "./release-download.ts";

export { formatSize, type Download } from "./release-download.ts";

/*
 * The download the site offers, looked up from GitHub when the site builds. Rebuild after
 * publishing a release to point at it; an older build still downloads a working app, which then
 * updates itself.
 *
 * If GitHub can't be reached, the build still succeeds and every download link opens the latest
 * release page instead, so a link on the site never 404s. GITHUB_TOKEN, when set, raises the
 * API rate limit on CI.
 */

async function resolve(): Promise<Download> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return downloadFromRelease(await response.json());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[marketing] Couldn't find the latest release (${reason}); linking the release page.`,
    );
    return releasePageDownload(links.latestRelease);
  }
}

export const download: Download = await resolve();
