/**
 * Pinned Windows Node runtime files ace stages for win32 desktop builds.
 *
 * The standalone `ReleaseTarget` schema in `@ace/protocol` stays unchanged (macOS and
 * Linux only): standalone updater/archive support for Windows is future work. Windows
 * desktop builds use this separate target union instead.
 *
 * Files come from the official pinned Node release only, with no zip dependency:
 * - `win-x64/node.exe` and `win-arm64/node.exe` from `https://nodejs.org/dist/v<version>/`
 * - the matching Node `LICENSE` from the official version source
 *   (`https://raw.githubusercontent.com/nodejs/node/v<version>/LICENSE`)
 *
 * Every staged byte is verified by SHA-256 against the pins below, which match the
 * official version `SHASUMS256.txt`
 * (`https://nodejs.org/dist/v24.13.0/SHASUMS256.txt` for the exes; the LICENSE pin
 * matches the tagged source file). This module is pure: no I/O, no fetch.
 */

import { join } from "node:path";

/** Windows desktop runtime targets. Separate from the standalone `ReleaseTarget`. */
export type WindowsDesktopRuntimeTarget = "win32-x64" | "win32-arm64";

export const windowsDesktopRuntimeTargets: readonly WindowsDesktopRuntimeTarget[] = [
  "win32-x64",
  "win32-arm64",
] as const;

export interface PinnedRuntimeFile {
  /** Exact byte length; also the streaming download limit. */
  bytes: number;
  /** Lowercase hex SHA-256 the download and cache must match. */
  sha256: string;
}

export interface WindowsNodeExeFile extends PinnedRuntimeFile {
  /** Path under the versioned Node distribution directory. */
  distPath: string;
}

/**
 * Pinned from the official Node v24.13.0 `SHASUMS256.txt`:
 * - `win-x64/node.exe`: d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11
 * - `win-arm64/node.exe`: 91e25b2ef61ee30a9e6afce0f336b4d55d688c3717244e496fa11d69fc3a1717
 */
export const windowsNodeExeFiles: Record<WindowsDesktopRuntimeTarget, WindowsNodeExeFile> = {
  "win32-x64": {
    distPath: "win-x64/node.exe",
    bytes: 89_953_280,
    sha256: "d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11",
  },
  "win32-arm64": {
    distPath: "win-arm64/node.exe",
    bytes: 79_135_232,
    sha256: "91e25b2ef61ee30a9e6afce0f336b4d55d688c3717244e496fa11d69fc3a1717",
  },
};

/**
 * Pinned matching Node v24.13.0 `LICENSE` from the official version source
 * (`https://raw.githubusercontent.com/nodejs/node/v24.13.0/LICENSE`).
 */
export const windowsNodeLicenseFile: PinnedRuntimeFile = {
  bytes: 143_310,
  sha256: "537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34",
};

/** Whether a `platform-arch` string names a Windows desktop runtime target. */
export function isWindowsDesktopRuntimeTarget(value: string): value is WindowsDesktopRuntimeTarget {
  return value === "win32-x64" || value === "win32-arm64";
}

/** Official versioned distribution base for a pinned Node version. */
export function nodeDistBaseUrl(version: string): string {
  return `https://nodejs.org/dist/v${version}`;
}

/** Official versioned LICENSE source for a pinned Node version. */
export function nodeLicenseUrl(version: string): string {
  return `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
}

/** Download URL for a Windows `node.exe` under a distribution base. */
export function windowsNodeExeUrl(baseUrl: string, target: WindowsDesktopRuntimeTarget): string {
  return `${baseUrl}/${windowsNodeExeFiles[target].distPath}`;
}

/** Cache filenames: exe entries are distinct per target; LICENSE is shared. */
export function windowsNodeCacheNames(
  version: string,
  target: WindowsDesktopRuntimeTarget,
): {
  exe: string;
  license: string;
} {
  return {
    exe: `node-v${version}-${target}.exe`,
    license: `node-v${version}-LICENSE`,
  };
}

/** Staged layout inside a `runtime/` destination: `node.exe` plus `LICENSE`. */
export function windowsRuntimePaths(destination: string): {
  exePath: string;
  licensePath: string;
} {
  return {
    exePath: join(destination, "node.exe"),
    licensePath: join(destination, "LICENSE"),
  };
}
