import { ReleaseData, type HomeData } from "@ace/protocol";
import { releaseLineOf, type ReleaseLine } from "@ace/service/release-line";
import {
  blockedSentence,
  candidates,
  guardSwitch,
  parseReleaseList,
  pickRelease,
  type ListedRelease,
} from "./release-picker.ts";

/**
 * The app's release feed (ADR 0174): GitHub's public releases API (no token), the picker, and
 * the guard's read of the chosen release's `ace-data.json`. electron-updater then reads that
 * release's own folder through its generic provider, so it still checks the SHA-512 in
 * `latest-mac.yml`, and Squirrel.Mac still checks the signature.
 */

export const githubReleases = {
  /** Newest first, a hundred a page; further pages follow the `Link` header. */
  api: "https://api.github.com/repos/arpan404/ace/releases?per_page=100",
  /** The newest stable release, for when the pages read hold none. */
  latest: "https://api.github.com/repos/arpan404/ace/releases/latest",
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
      /** The release's `ace-data.json`, for an older one: the guard runs again before install. */
      data?: ReleaseData | undefined;
      notes: { version: string; note: string }[];
    };

const headers = { accept: "application/vnd.github+json", "user-agent": "ace-desktop" };

/** The release to offer on `line`, after the guard for an older one. Throws when GitHub fails. */
export async function checkReleaseFeed(
  ports: FeedPorts,
  input: { installed: string; line: ReleaseLine; home: HomeData | undefined },
): Promise<FeedResult> {
  const pick = pickRelease({
    releases: await listReleases(ports),
    installed: input.installed,
    line: input.line,
  });
  if (pick.kind === "current") return pick;
  const { tag, version } = pick.release;
  const folder = `${ports.urls.download}${encodeURIComponent(tag)}/`;
  const data = pick.older ? await releaseData(ports, folder) : undefined;
  if (pick.older) {
    const guard = guardSwitch(data, input.home);
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
    ...(data ? { data } : {}),
    notes: pick.notes,
  };
}

/** At most this many pages of the release list (100 each) are read in one check. */
export const releasePageLimit = 5;

/**
 * GitHub's release list, newest first, read until it reaches a stable release: everything newer
 * than that is then in hand, so neither line's pick can miss. Betas could fill more pages than
 * the limit, so if none of them held a stable release, `/releases/latest` adds the newest.
 */
async function listReleases(ports: FeedPorts): Promise<ListedRelease[]> {
  const listed: ListedRelease[] = [];
  const hasStable = () => candidates(listed).some((release) => release.line === "stable");
  let url: string | undefined = ports.urls.api;
  for (let page = 0; url && page < releasePageLimit && !hasStable(); page++) {
    const response = await ports.fetch(url, { headers });
    if (!response.ok) throw new Error(`GitHub's release list answered ${response.status}.`);
    listed.push(...parseReleaseList(await response.json()));
    url = nextPage(response.headers.get("link"));
  }
  if (!hasStable()) {
    const response = await ports.fetch(ports.urls.latest, { headers });
    // No stable release at all answers 404: the list stands as it is.
    if (response.ok) listed.push(...parseReleaseList([await response.json()]));
    else if (response.status !== 404)
      throw new Error(`GitHub's latest release answered ${response.status}.`);
  }
  return listed;
}

/** The `rel="next"` URL of a `Link` header, if any. */
export function nextPage(link: string | null): string | undefined {
  for (const part of link?.split(",") ?? []) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/.exec(part);
    if (match?.[1]) return match[1];
  }
  return undefined;
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
