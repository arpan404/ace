const REPO = "pingdotgg/t3code";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "t3code-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseReleaseAsset(value: unknown): ReleaseAsset | null {
  if (!isRecord(value)) {
    return null;
  }

  return typeof value.name === "string" && typeof value.browser_download_url === "string"
    ? {
        name: value.name,
        browser_download_url: value.browser_download_url,
      }
    : null;
}

function parseRelease(value: unknown): Release | null {
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    return null;
  }

  const assets = value.assets
    .map((asset) => parseReleaseAsset(asset))
    .filter((asset): asset is ReleaseAsset => asset !== null);

  return typeof value.tag_name === "string" && typeof value.html_url === "string"
    ? {
        tag_name: value.tag_name,
        html_url: value.html_url,
        assets,
      }
    : null;
}

function parseReleaseJson(raw: string): Release | null {
  try {
    return parseRelease(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    const release = parseReleaseJson(cached);
    if (release) {
      return release;
    }
    sessionStorage.removeItem(CACHE_KEY);
  }

  const response = await fetch(API_URL);
  const data = await response.json();
  const release = parseRelease(data);
  if (!release) {
    throw new Error(
      response.ok
        ? "GitHub releases API returned an unexpected payload."
        : `GitHub releases API request failed with status ${response.status}.`,
    );
  }

  if (release.assets.length > 0) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(release));
  }

  return release;
}
