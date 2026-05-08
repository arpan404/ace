import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "bun.lock",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/marketing/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: ace-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: ace-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: ace-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: ace-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: ace-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: ace-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsManifestFixtures(targetRoot: string): { x64Path: string; arm64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const x64Path = resolve(assetDirectory, "latest.yml");
  const arm64Path = resolve(assetDirectory, "latest-arm64.yml");

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: ace-9.9.9-smoke.0-x64.exe
    sha512: x64exe
    size: 188743680
packages:
  x64:
    path: ace-9.9.9-smoke.0-x64.nsis.7z
    sha512: x64pkg
    size: 174325760
path: ace-9.9.9-smoke.0-x64.exe
sha512: x64exe
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: ace-9.9.9-smoke.0-arm64.exe
    sha512: arm64exe
    size: 180355072
packages:
  arm64:
    path: ace-9.9.9-smoke.0-arm64.nsis.7z
    sha512: arm64pkg
    size: 166723584
path: ace-9.9.9-smoke.0-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { x64Path, arm64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "ace-release-smoke-"));

try {
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path: macArm64Path, x64Path: macX64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), macArm64Path, macX64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(macArm64Path, "utf8");
  assertContains(
    mergedManifest,
    "ace-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "ace-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  const { x64Path: windowsX64Path, arm64Path: windowsArm64Path } =
    writeWindowsManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/merge-windows-update-manifests.ts"),
      windowsX64Path,
      windowsArm64Path,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedWindowsManifest = readFileSync(windowsX64Path, "utf8");
  assertContains(
    mergedWindowsManifest,
    "ace-9.9.9-smoke.0-x64.exe",
    "Merged Windows manifest is missing the x64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "ace-9.9.9-smoke.0-arm64.exe",
    "Merged Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "  arm64:",
    "Merged Windows manifest is missing the arm64 package entry.",
  );

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
