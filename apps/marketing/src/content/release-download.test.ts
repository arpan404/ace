import { expect, test } from "vitest";
import { downloadsFromRelease } from "./release-download.ts";

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

const page = "https://github.com/arpan404/ace/releases/tag/v0.0.7";
const asset = (name: string, size: number) => ({
  name,
  size,
  browser_download_url: `${base}/${name}`,
});

test("download for Mac points at the release's Apple-silicon disk image, not its blockmap or zip", () => {
  expect(downloadsFromRelease(release()).byPlatform.mac).toEqual({
    url: `${base}/ace-0.0.7-arm64.dmg`,
    bytes: 215239626,
  });
});

test("the release's version, notes and date come with the downloads", () => {
  const downloads = downloadsFromRelease(release());
  expect(downloads.version).toBe("0.0.7");
  expect(downloads.notesUrl).toBe(page);
  expect(downloads.publishedAt).toBe("2026-10-22T11:09:25Z");
});

test("Windows and Linux point at the x64 installer and AppImage, not the deb, arm64 or blockmap", () => {
  const assets = [
    ...release().assets,
    asset("ace-0.0.7-arm64-setup.exe", 180000000),
    asset("ace-0.0.7-x64-setup.exe.blockmap", 190000),
    asset("ace-0.0.7-x64-setup.exe", 190000000),
    asset("ace-0.0.7-x64.deb", 150000000),
    asset("ace-0.0.7-x64.AppImage", 200000000),
  ];
  const { byPlatform } = downloadsFromRelease(release({ assets }));
  expect(byPlatform.windows).toEqual({ url: `${base}/ace-0.0.7-x64-setup.exe`, bytes: 190000000 });
  expect(byPlatform.linux).toEqual({ url: `${base}/ace-0.0.7-x64.AppImage`, bytes: 200000000 });
});

test("a platform the release has no installer for opens the release page instead", () => {
  const assets = release().assets.filter((candidate) => !candidate.name.endsWith(".dmg"));
  const { byPlatform } = downloadsFromRelease(release({ assets }));
  expect(byPlatform.mac).toEqual({ url: page, bytes: undefined });
  expect(byPlatform.windows).toEqual({ url: page, bytes: undefined });
  expect(byPlatform.linux).toEqual({ url: page, bytes: undefined });
});

test("a prerelease is never offered as the download", () => {
  expect(() => downloadsFromRelease(release({ prerelease: true }))).toThrow(/isn't published/);
});

test("an answer that isn't a release, such as a rate-limit error, is refused", () => {
  expect(() =>
    downloadsFromRelease({
      message: "API rate limit exceeded",
      documentation_url: "https://docs.github.com",
    }),
  ).toThrow();
});
