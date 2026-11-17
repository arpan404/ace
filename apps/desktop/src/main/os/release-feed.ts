import { ReleaseData, type HomeData } from "@ace/protocol";
import { releaseLineOf, type ReleaseLine } from "@ace/service/release-line";
import { blockedSentence, guardSwitch, parseReleaseList, pickRelease } from "./release-picker.ts";

/**
 * The app's release feed (ADR 0174): GitHub's public releases API (no token), the picker, and
 * the guard's read of the chosen release's `ace-data.json`. electron-updater then reads that
 * release's own folder through its generic provider, so it still checks the SHA-512 in
 * `latest-mac.yml`, and Squirrel.Mac still checks the signature.
 */

export const githubReleases = {
  /** Newest first; a hundred covers months of betas. */
  api: "https://api.github.com/repos/arpan404/ace/releases?per_page=100",
  /** `<download><tag>/` holds a release's files, its `latest*.yml` among them. */
  download: "https://github.com/arpan404/ace/releases/download/",
  page: "https://github.com/arpan404/ace/releases/tag/",
};

export interface FeedPorts {
  fetch: typeof globalThis.fetch;
  urls: typeof githubReleases;
}

export type FeedResult =
  | { kind: "current" }
  /** An older release can't read this home: the one sentence that says so. */
  | { kind: "blocked"; message: string }
  | {
      kind: "offer";
      tag: string;
      version: string;
      /** The generic provider's base: the release's own download folder. */
      feedUrl: string;
      releaseUrl: string;
      /** Ranks below the installed version, and the guard allowed it. */
      older: boolean;
      notes: { version: string; note: string }[];
    };

const headers = { accept: "application/vnd.github+json", "user-agent": "ace-desktop" };

/** The release to offer on `line`, after the guard for an older one. Throws when GitHub fails. */
export async function checkReleaseFeed(
  ports: FeedPorts,
  input: { installed: string; line: ReleaseLine; home: HomeData | undefined },
): Promise<FeedResult> {
  const response = await ports.fetch(ports.urls.api, { headers });
  if (!response.ok) throw new Error(`GitHub's release list answered ${response.status}.`);
  const pick = pickRelease({
    releases: parseReleaseList(await response.json()),
    installed: input.installed,
    line: input.line,
  });
  if (pick.kind === "current") return pick;
  const { tag, version } = pick.release;
  const folder = `${ports.urls.download}${encodeURIComponent(tag)}/`;
  if (pick.older) {
    const guard = guardSwitch(await releaseData(ports, folder), input.home);
    if (!guard.ok)
      return {
        kind: "blocked",
        message: blockedSentence(guard.reason, releaseLineOf(input.installed), input.line),
      };
  }
  return {
    kind: "offer",
    tag,
    version,
    feedUrl: folder,
    releaseUrl: `${ports.urls.page}${encodeURIComponent(tag)}`,
    older: pick.older,
    notes: pick.notes,
  };
}

/** The release's `ace-data.json`, or undefined when it has none or it can't be read. */
async function releaseData(ports: FeedPorts, folder: string): Promise<ReleaseData | undefined> {
  try {
    const response = await ports.fetch(`${folder}ace-data.json`, {
      headers: { "user-agent": headers["user-agent"] },
    });
    if (!response.ok) return undefined;
    return ReleaseData.safeParse(await response.json()).data;
  } catch {
    return undefined;
  }
}
