import { expect, test } from "vitest";
import { filesFor, pickFile, pickInstaller, readRelease } from "./release-pick.ts";

const base = "https://github.com/arpan404/ace/releases/download/v0.1.0";
const page = "https://github.com/arpan404/ace/releases/tag/v0.1.0";
const asset = (name: string, size: number) => ({
  name,
  size,
  browser_download_url: `${base}/${name}`,
});

const release = readRelease({
  tag_name: "v0.1.0",
  html_url: page,
  published_at: "2026-11-01T10:00:00Z",
  draft: false,
  prerelease: false,
  assets: [
    asset("ace-0.1.0-arm64.dmg", 230),
    asset("ace-0.1.0-arm64.dmg.blockmap", 1),
    asset("ace-0.1.0-x64-setup.exe", 190),
    asset("ace-0.1.0-arm64-setup.exe", 180),
    asset("ace-0.1.0-x86_64.AppImage", 200),
    asset("ace-0.1.0-amd64.deb", 150),
    asset("ace-0.1.0-arm64.deb", 140),
    asset("ace-0.1.0-x64.tar.gz", 210),
    asset("ace-0.1.0-linux-x64.tar.gz", 90),
    asset("ace-0.1.0-arm64-mac.zip", 225),
  ],
});

test("each computer gets the installer built for its own chip", () => {
  expect(pickInstaller(release, "mac", "arm64").url).toBe(`${base}/ace-0.1.0-arm64.dmg`);
  expect(pickInstaller(release, "windows", "arm64").url).toBe(`${base}/ace-0.1.0-arm64-setup.exe`);
  expect(pickInstaller(release, "windows", "x64").url).toBe(`${base}/ace-0.1.0-x64-setup.exe`);
  expect(pickInstaller(release, "linux", "x64")).toEqual({
    url: `${base}/ace-0.1.0-x86_64.AppImage`,
    bytes: 200,
  });
});

test("an Intel Mac is sent to the release page, never handed the Apple-silicon build", () => {
  expect(pickInstaller(release, "mac", "x64")).toEqual({ url: page, bytes: undefined });
});

test("a chip the release has no build for opens the release page", () => {
  expect(pickInstaller(release, "linux", "arm64")).toEqual({ url: page, bytes: undefined });
});

test("drafts and answers that aren't releases are refused", () => {
  expect(() =>
    readRelease({
      tag_name: "v0.2.0",
      html_url: page,
      published_at: null,
      draft: true,
      prerelease: false,
      assets: [],
    }),
  ).toThrow(/isn't published/);
  expect(() => readRelease({ message: "API rate limit exceeded" })).toThrow();
});

test("a Linux package is found under the chip name its format uses", () => {
  expect(pickFile(release, "linux", "appimage", "x64").url).toBe(
    `${base}/ace-0.1.0-x86_64.AppImage`,
  );
  expect(pickFile(release, "linux", "deb", "x64").url).toBe(`${base}/ace-0.1.0-amd64.deb`);
  expect(pickFile(release, "linux", "deb", "arm64").url).toBe(`${base}/ace-0.1.0-arm64.deb`);
});

test("the desktop archive is offered, never the daemon's archive of the same chip", () => {
  expect(pickFile(release, "linux", "tar", "x64")).toEqual({
    url: `${base}/ace-0.1.0-x64.tar.gz`,
    bytes: 210,
  });
});

test("a kind a system doesn't have opens the release page", () => {
  expect(pickFile(release, "mac", "appimage", "arm64")).toEqual({ url: page, bytes: undefined });
});

test("a system's files list only what the release has, its usual chip first", () => {
  expect(filesFor(release, "linux").map((file) => `${file.kind} ${file.arch}`)).toEqual([
    "appimage x64",
    "deb x64",
    "deb arm64",
    "tar x64",
  ]);
  expect(filesFor(release, "mac").map((file) => `${file.kind} ${file.arch}`)).toEqual([
    "dmg arm64",
    "zip arm64",
  ]);
  expect(filesFor(release, "windows").map((file) => file.arch)).toEqual(["x64", "arm64"]);
});
