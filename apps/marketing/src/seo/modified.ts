import { execFileSync } from "node:child_process";
import { downloads } from "../content/release.ts";
import { dayOf } from "./sitemap.ts";

/*
 * The day the site's words last changed, for the sitemap's lastmod and each page's
 * dateModified: the last commit that touched the site's source (every page is built from shared
 * content files). Without git (an exported tarball), the latest release's date, when the site
 * was last rebuilt for sure. Read once per build.
 */
function lastCommitDay(): string | undefined {
  try {
    // The build runs from apps/marketing; from anywhere else "src" matches nothing.
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", "src"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return dayOf(out);
  } catch {
    return undefined;
  }
}

export const siteModified: string | undefined = lastCommitDay() ?? dayOf(downloads.publishedAt);
