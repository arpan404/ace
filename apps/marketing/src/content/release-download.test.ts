import { expect, test } from "vitest";
import { downloadFromRelease } from "./release-download.ts";

const base = "https://github.com/arpan404/ace/releases/download/v0.0.7";

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v0.0.7",
    html_url: "https://github.com/arpan404/ace/releases/tag/v0.0.7",
    published_at: "2026-10-22T11:09:25Z",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "ace-0.0.7-arm64-mac.zip",
        size: 215672861,
        browser_download_url: `${base}/ace-0.0.7-arm64-mac.zip`,
      },
      {
        name: "ace-0.0.7-arm64.dmg.blockmap",
        size: 226280,
        browser_download_url: `${base}/ace-0.0.7-arm64.dmg.blockmap`,
      },
      {
        name: "ace-0.0.7-arm64.dmg",
        size: 215239626,
        browser_download_url: `${base}/ace-0.0.7-arm64.dmg`,
      },
      {
        name: "ace-0.0.7-darwin-x64.tar.gz",
        size: 67731002,
        browser_download_url: `${base}/ace-0.0.7-darwin-x64.tar.gz`,
      },
    ],
    ...overrides,
  };
}

test("download for Mac points at the release's Apple-silicon disk image, not its blockmap or zip", () => {
  expect(downloadFromRelease(release())).toEqual({
    url: `${base}/ace-0.0.7-arm64.dmg`,
    version: "0.0.7",
    notesUrl: "https://github.com/arpan404/ace/releases/tag/v0.0.7",
    bytes: 215239626,
    publishedAt: "2026-10-22T11:09:25Z",
  });
});

test("a release without a disk image is refused, so the site falls back to the release page", () => {
  const assets = release().assets.filter((asset) => !asset.name.endsWith(".dmg"));
  expect(() => downloadFromRelease(release({ assets }))).toThrow(/no Apple-silicon disk image/);
});

test("a prerelease is never offered as the download", () => {
  expect(() => downloadFromRelease(release({ prerelease: true }))).toThrow(/isn't published/);
});

test("an answer that isn't a release, such as a rate-limit error, is refused", () => {
  expect(() =>
    downloadFromRelease({
      message: "API rate limit exceeded",
      documentation_url: "https://docs.github.com",
    }),
  ).toThrow();
});
