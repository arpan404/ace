import { expect, it } from "vitest";
import {
  changedFiles,
  checksumList,
  combineStaged,
  daemonAssets,
  daemonTargetsFor,
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

it("a Linux release publishes the AppImage, deb and desktop tar.gz, not the unpacked app", () => {
  const output = [
    "ace-1.2.0-arm64.AppImage",
    "ace-1.2.0-arm64.deb",
    "ace-1.2.0-arm64.tar.gz",
    "latest-linux-arm64.yml",
    "linux-arm64-unpacked",
    "builder-debug.yml",
    "ace-1.1.0-arm64.tar.gz",
  ];
  expect(desktopAssets(output, "1.2.0")).toEqual([
    "ace-1.2.0-arm64.AppImage",
    "ace-1.2.0-arm64.deb",
    "ace-1.2.0-arm64.tar.gz",
    "latest-linux-arm64.yml",
  ]);
});

it("a Linux feed without the AppImage its updater installs is caught before publishing", () => {
  expect(
    missingUpdatePackages([
      "ace-1.2.0-arm64.deb",
      "ace-1.2.0-arm64.tar.gz",
      "latest-linux-arm64.yml",
    ]),
  ).toEqual(["Linux AppImage"]);
  expect(missingUpdatePackages(["ace-1.2.0-x64.AppImage", "latest-linux.yml"])).toEqual([]);
});

it("a Linux host releases only its own daemon target; a Mac releases the Apple silicon one", () => {
  expect(daemonTargetsFor("linux", "arm64")).toEqual(["linux-arm64"]);
  expect(daemonTargetsFor("linux", "x64")).toEqual(["linux-x64"]);
  expect(daemonTargetsFor("darwin", "arm64")).toEqual(["darwin-arm64"]);
  expect(() => daemonTargetsFor("win32", "x64")).toThrow();
});

function staged(overrides: Partial<StagedRelease>): StagedRelease {
  return {
    version: "1.2.0",
    tag: "v1.2.0",
    commit: "a".repeat(40),
    dirty: false,
    signed: false,
    notarized: false,
    files: [],
    ...overrides,
  };
}

it("one release combines the Mac's and each Linux host's staged builds of the same commit", () => {
  const mac = staged({
    signed: true,
    notarized: true,
    files: [{ name: "latest-mac.yml", bytes: 1, sha256: "1".repeat(64) }],
  });
  const linux = staged({
    files: [
      { name: "latest-linux-arm64.yml", bytes: 1, sha256: "2".repeat(64) },
      { name: "ace-1.2.0-arm64.AppImage", bytes: 1, sha256: "3".repeat(64) },
    ],
  });
  const combined = combineStaged([mac, linux]);
  expect(combined.files.map((file) => file.name)).toEqual([
    "ace-1.2.0-arm64.AppImage",
    "latest-linux-arm64.yml",
    "latest-mac.yml",
  ]);
  // The Linux packages are unsigned, so the release as a whole is not.
  expect(combined).toMatchObject({ signed: false, notarized: false, dirty: false });
});

it("builds of different commits, versions or overlapping files never become one release", () => {
  const file = { name: "SHA256SUMS-extra", bytes: 1, sha256: "1".repeat(64) };
  expect(() => combineStaged([staged({}), staged({ commit: "b".repeat(40) })])).toThrow(
    "different commits",
  );
  expect(() => combineStaged([staged({}), staged({ version: "1.3.0", tag: "v1.3.0" })])).toThrow(
    "different versions",
  );
  expect(() => combineStaged([staged({ files: [file] }), staged({ files: [file] })])).toThrow(
    "more than one build: SHA256SUMS-extra",
  );
  expect(combineStaged([staged({}), staged({ dirty: true })]).dirty).toBe(true);
  expect(() => combineStaged([])).toThrow();
});

it("standalone daemon archives of this version ride along with their signed manifests", () => {
  const output = [
    "darwin-arm64.json",
    "darwin-arm64.sig",
    "ace-1.2.0-darwin-arm64.tar.gz",
    "ace-1.1.0-darwin-x64.tar.gz",
    "darwin-arm64",
    "node-v26.12.1-darwin-arm64.tar.gz",
  ];
  expect(daemonAssets(output, "1.2.0", ["darwin-arm64"])).toEqual([
    "ace-1.2.0-darwin-arm64.tar.gz",
    "darwin-arm64.json",
    "darwin-arm64.sig",
  ]);
});

it("a macOS release excludes leftover Linux manifests and archives, even at the same version", () => {
  const output = [
    "darwin-arm64.json",
    "darwin-arm64.sig",
    "ace-1.2.0-darwin-arm64.tar.gz",
    "linux-x64.json",
    "linux-x64.sig",
    "ace-1.1.0-linux-x64.tar.gz",
    "linux-arm64.json",
    "linux-arm64.sig",
    "ace-1.2.0-linux-arm64.tar.gz",
  ];
  expect(daemonAssets(output, "1.2.0", ["darwin-arm64"])).toEqual([
    "ace-1.2.0-darwin-arm64.tar.gz",
    "darwin-arm64.json",
    "darwin-arm64.sig",
  ]);
});

it.each(["darwin-arm64.json", "darwin-arm64.sig", "ace-1.2.0-darwin-arm64.tar.gz"])(
  "a release refuses a rebuilt daemon target missing %s",
  (missing) => {
    const output = ["darwin-arm64.json", "darwin-arm64.sig", "ace-1.2.0-darwin-arm64.tar.gz"];
    expect(() =>
      daemonAssets(
        output.filter((name) => name !== missing),
        "1.2.0",
        ["darwin-arm64"],
      ),
    ).toThrow(missing);
  },
);

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
