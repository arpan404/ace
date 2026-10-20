import { posix, win32 } from "node:path";
import { z } from "zod";
import { ReleaseVersion } from "@ace/protocol";
import { isNewer } from "./version.ts";

/**
 * What the desktop app and the CLI bundled inside it share about the app's own update
 * (ADR 0091). The app updates itself through electron-updater; its bundled `ace update`
 * hands the request to the app instead of installing a standalone release.
 */

export { desktopUpdateArgument } from "./desktop-update-argument.ts";

/** Written beside the bundled daemon (`daemon/desktop-app.json`) by the desktop build. */
export const desktopAppMarker = "desktop-app.json";
export const DesktopApp = z.object({ version: ReleaseVersion });
export type DesktopApp = z.infer<typeof DesktopApp>;

/**
 * The app's executable from its bundled daemon directory (`<resources>/daemon`): macOS
 * `ace.app/Contents/Resources/daemon` → `Contents/MacOS/ace`; Linux and Windows keep
 * `resources/` beside the executable.
 */
export function desktopExecutable(daemonDirectory: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  const resources = path.dirname(daemonDirectory);
  if (platform === "darwin") return path.join(path.dirname(resources), "MacOS", "ace");
  return path.join(path.dirname(resources), platform === "win32" ? "ace.exe" : "ace");
}

/** The fields of GitHub's release list this needs; anything else is ignored. */
export const GithubRelease = z.object({
  tag_name: z.string().max(100),
  draft: z.boolean(),
  prerelease: z.boolean(),
});
export type GithubRelease = z.infer<typeof GithubRelease>;

/**
 * The newest published release this install would move to, if newer than `current`. A
 * stable install sees stable releases only; a preview install (a version with `-`) sees
 * previews too, as electron-updater's `allowPrerelease` does. Tags that are not `v<semver>`
 * (the daemon's moving `preview` tag) are skipped.
 */
export function newerDesktopRelease(
  releases: readonly GithubRelease[],
  current: string,
): string | undefined {
  const preview = current.includes("-");
  let newest: string | undefined;
  for (const release of releases) {
    if (release.draft || (release.prerelease && !preview)) continue;
    const version = ReleaseVersion.safeParse(release.tag_name.replace(/^v/, ""));
    if (!version.success || !release.tag_name.startsWith("v")) continue;
    if (!newest || isNewer(version.data, newest)) newest = version.data;
  }
  return newest && isNewer(newest, current) ? newest : undefined;
}
