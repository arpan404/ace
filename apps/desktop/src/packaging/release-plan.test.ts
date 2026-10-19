import { expect, it } from "vitest";
import {
  changedFiles,
  checksumList,
  daemonAssets,
  desktopAssets,
  missingUpdatePackages,
  type StagedRelease,
} from "./release-plan.ts";

it("a release publishes this version's packages and the update feed, not the builder's logs", () => {
  const output = [
    "ace-1.2.0-arm64.dmg",
    "ace-1.2.0-arm64.dmg.blockmap",
    "ace-1.2.0-arm64-mac.zip",
    "ace-1.2.0-arm64-mac.zip.blockmap",
    "latest-mac.yml",
    "builder-debug.yml",
    "builder-effective-config.yaml",
    "mac-arm64",
    "ace-1.1.0-arm64.dmg",
    "ace-1.2.0-x64.dmg",
  ];
  expect(desktopAssets(output, "1.2.0")).toEqual([
    "ace-1.2.0-arm64-mac.zip",
    "ace-1.2.0-arm64-mac.zip.blockmap",
    "ace-1.2.0-arm64.dmg",
    "ace-1.2.0-arm64.dmg.blockmap",
    "ace-1.2.0-x64.dmg",
    "latest-mac.yml",
  ]);
});

it("a preview release carries its own channel's feed and its prerelease packages", () => {
  const output = [
    "ace-1.2.0-preview.1-arm64-mac.zip",
    "preview-mac.yml",
    "ace-1.2.0-arm64-mac.zip",
  ];
  expect(desktopAssets(output, "1.2.0-preview.1")).toEqual([
    "ace-1.2.0-preview.1-arm64-mac.zip",
    "preview-mac.yml",
  ]);
});

it("Windows and Linux packages and feeds are published too", () => {
  const output = [
    "ace-1.2.0-x64-setup.exe",
    "ace-1.2.0-x64-setup.exe.blockmap",
    "latest.yml",
    "ace-1.2.0-x86_64.AppImage",
    "ace-1.2.0-amd64.deb",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
  ];
  expect(desktopAssets(output, "1.2.0")).toHaveLength(output.length);
});

it("a macOS feed without the zip Squirrel installs from is caught before publishing", () => {
  expect(missingUpdatePackages(["ace-1.2.0-arm64.dmg", "latest-mac.yml"])).toEqual(["macOS zip"]);
  expect(missingUpdatePackages(["ace-1.2.0-arm64-mac.zip", "latest-mac.yml"])).toEqual([]);
});

it("standalone daemon archives of this version ride along with their signed manifests", () => {
  const output = [
    "darwin-arm64.json",
    "darwin-arm64.sig",
    "ace-1.2.0-darwin-arm64.tar.gz",
    "ace-1.1.0-darwin-x64.tar.gz",
    "darwin-arm64",
    "node-v24.13.0-darwin-arm64.tar.gz",
  ];
  expect(daemonAssets(output, "1.2.0")).toEqual([
    "ace-1.2.0-darwin-arm64.tar.gz",
    "darwin-arm64.json",
    "darwin-arm64.sig",
  ]);
});

it("publishing refuses staged files whose bytes changed since the build", () => {
  const release: StagedRelease = {
    version: "1.2.0",
    tag: "v1.2.0",
    commit: "a".repeat(40),
    dirty: false,
    signed: true,
    notarized: true,
    files: [
      { name: "latest-mac.yml", bytes: 300, sha256: "1".repeat(64) },
      { name: "ace-1.2.0-arm64-mac.zip", bytes: 9, sha256: "2".repeat(64) },
    ],
  };
  expect(checksumList(release)).toBe(
    `${"1".repeat(64)}  latest-mac.yml\n${"2".repeat(64)}  ace-1.2.0-arm64-mac.zip\n`,
  );
  const actual = new Map([
    ["latest-mac.yml", "1".repeat(64)],
    ["ace-1.2.0-arm64-mac.zip", "3".repeat(64)],
  ]);
  expect(changedFiles(release, actual)).toEqual(["ace-1.2.0-arm64-mac.zip"]);
  expect(changedFiles(release, new Map([["latest-mac.yml", "1".repeat(64)]]))).toEqual([
    "ace-1.2.0-arm64-mac.zip",
  ]);
});
