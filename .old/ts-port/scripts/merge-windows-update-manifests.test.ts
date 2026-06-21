import { assert, describe, it } from "@effect/vitest";

import {
  mergeWindowsUpdateManifests,
  parseWindowsUpdateManifest,
  serializeWindowsUpdateManifest,
} from "./merge-windows-update-manifests.ts";

describe("merge-windows-update-manifests", () => {
  it("merges x64 and arm64 Windows update manifests into one multi-arch manifest", () => {
    const x64 = parseWindowsUpdateManifest(
      `version: 0.0.4
files:
  - url: ace-0.0.4-x64.exe
    sha512: x64exe
    size: 188743680
  - url: ace-0.0.4-x64.exe.blockmap
    sha512: x64blockmap
    size: 62014
packages:
  x64:
    path: ace-0.0.4-x64.nsis.7z
    sha512: x64package
    size: 174325760
path: ace-0.0.4-x64.exe
sha512: x64exe
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest.yml",
    );

    const arm64 = parseWindowsUpdateManifest(
      `version: 0.0.4
files:
  - url: ace-0.0.4-arm64.exe
    sha512: arm64exe
    size: 180355072
  - url: ace-0.0.4-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 60123
packages:
  arm64:
    path: ace-0.0.4-arm64.nsis.7z
    sha512: arm64package
    size: 166723584
path: ace-0.0.4-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-arm64.yml",
    );

    const merged = mergeWindowsUpdateManifests(x64, arm64);

    assert.equal(merged.version, "0.0.4");
    assert.equal(merged.releaseDate, "2026-03-07T10:36:07.540Z");
    assert.equal(merged.path, "ace-0.0.4-x64.exe");
    assert.equal(merged.sha512, "x64exe");
    assert.deepStrictEqual(
      merged.files.map((file) => file.url),
      [
        "ace-0.0.4-x64.exe",
        "ace-0.0.4-x64.exe.blockmap",
        "ace-0.0.4-arm64.exe",
        "ace-0.0.4-arm64.exe.blockmap",
      ],
    );
    assert.deepStrictEqual(Object.keys(merged.packages), ["x64", "arm64"]);

    const serialized = serializeWindowsUpdateManifest(merged);
    assert.ok(serialized.includes("packages:"));
    assert.ok(serialized.includes("  x64:"));
    assert.ok(serialized.includes("  arm64:"));
  });

  it("rejects mismatched manifest versions", () => {
    const x64 = parseWindowsUpdateManifest(
      `version: 0.0.4
files:
  - url: ace-0.0.4-x64.exe
    sha512: x64exe
path: ace-0.0.4-x64.exe
sha512: x64exe
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest.yml",
    );

    const arm64 = parseWindowsUpdateManifest(
      `version: 0.0.5
files:
  - url: ace-0.0.5-arm64.exe
    sha512: arm64exe
path: ace-0.0.5-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-arm64.yml",
    );

    assert.throws(() => mergeWindowsUpdateManifests(x64, arm64), /different versions/);
  });

  it("preserves quoted scalars and package metadata", () => {
    const manifest = parseWindowsUpdateManifest(
      `version: '1.0'
files:
  - url: ace-1.0-arm64.exe
    sha512: exesha
    size: 10
packages:
  arm64:
    path: ace-1.0-arm64.nsis.7z
    sha512: pkgsha
    size: 9
releaseName: 'true'
minimumSystemVersion: '10.0.22631'
stagingPercentage: 50
path: ace-1.0-arm64.exe
sha512: exesha
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-arm64.yml",
    );

    assert.equal(manifest.version, "1.0");
    assert.equal(manifest.extras.releaseName, "true");
    assert.equal(manifest.extras.minimumSystemVersion, "10.0.22631");
    assert.equal(manifest.extras.stagingPercentage, 50);
    assert.equal(manifest.packages.arm64?.path, "ace-1.0-arm64.nsis.7z");
  });
});
