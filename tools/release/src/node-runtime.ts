import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { extract } from "tar";
import type { z } from "zod";
import type { ReleaseTarget as ReleaseTargets } from "@ace/protocol";
import { downloadArchive, hashFile } from "@ace/service";

/** Targets of the standalone archive and its updater: macOS and Linux only. */
export type ReleaseTarget = z.infer<typeof ReleaseTargets>;
type WindowsTarget = "win32-x64" | "win32-arm64";
/**
 * Targets that ship a Node runtime. Desktop builds add Windows; the protocol's `ReleaseTarget`
 * stays unchanged because the standalone updater has no Windows archives.
 */
export type RuntimeTarget = ReleaseTarget | WindowsTarget;

export function isWindowsTarget(target: string): target is WindowsTarget {
  return target === "win32-x64" || target === "win32-arm64";
}

/** The `platform-arch` string as a runtime target, or undefined when ace ships none for it. */
export function runtimeTarget(value: string): RuntimeTarget | undefined {
  return value === "darwin-arm64" ||
    value === "darwin-x64" ||
    value === "linux-arm64" ||
    value === "linux-x64" ||
    isWindowsTarget(value)
    ? value
    : undefined;
}

/** The Node runtime ace ships beside its daemon (standalone archive and desktop app). */
export const nodeVersion = "24.13.0";

interface PinnedFile {
  /** Exact byte length; also the streaming download limit. Unpinned: the response's length. */
  bytes?: number;
  /** Lowercase hex SHA-256 the download and cache must match. */
  sha256: string;
}

/**
 * Pinned from the official Node v24.13.0 `SHASUMS256.txt`. macOS and Linux ship the official
 * `.tar.gz`; Windows ships the raw `win-<arch>/node.exe` (no zip dependency) plus the `LICENSE`
 * from the tagged source, which the Windows distribution keeps only inside its zip.
 */
const archives: Record<ReleaseTarget, string> = {
  "darwin-arm64": "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
  "darwin-x64": "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
  "linux-arm64": "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
  "linux-x64": "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
};
const windowsExes: Record<WindowsTarget, Required<PinnedFile>> = {
  "win32-x64": {
    bytes: 89_953_280,
    sha256: "d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11",
  },
  "win32-arm64": {
    bytes: 79_135_232,
    sha256: "91e25b2ef61ee30a9e6afce0f336b4d55d688c3717244e496fa11d69fc3a1717",
  },
};
const windowsLicense: Required<PinnedFile> = {
  bytes: 143_310,
  sha256: "537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34",
};

/** The staged Node executable inside a `runtime/` directory. */
export function runtimeNodePath(destination: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(destination, "node.exe") : join(destination, "bin", "node");
}

async function trusted(path: string, sha256: string): Promise<boolean> {
  return hashFile(path).then(
    (hash) => hash === sha256,
    () => false,
  );
}

/**
 * Downloads one pinned file into the cache, reusing the cached copy only while its SHA-256
 * matches the pin. Concurrent stagings may share a cache entry, so it is never removed in
 * place: the download streams into a unique temp file through `downloadArchive` (which caps
 * bytes and rejects checksum mismatches), then the verified file is published atomically. A
 * failed download leaves no partial cache entry; a lost publish race reuses the winner's file.
 */
async function fetchPinned(options: {
  url: string;
  cachePath: string;
  file: PinnedFile;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { cachePath, file } = options;
  if (await trusted(cachePath, file.sha256)) return;
  const tempPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    const response = await options.fetchImpl(options.url, {
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = file.bytes ?? Number(response.headers.get("content-length"));
    await downloadArchive(response, tempPath, { bytes, sha256: file.sha256 });
    if (!(await trusted(cachePath, file.sha256))) await rename(tempPath, cachePath);
  } catch (error) {
    if (!(await trusted(cachePath, file.sha256))) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  await rm(tempPath, { force: true }).catch(() => {});
}

/**
 * Puts Node and its `LICENSE` for `target` into `destination` (a `runtime/` directory):
 * `bin/node` from the official archive on macOS and Linux, `node.exe` on Windows. Downloads are
 * cached in `cacheDir` and used only while their SHA-256 matches the pin; otherwise each is
 * downloaded again and verified before staging. No shell, no credentials.
 */
export async function stageNodeRuntime(options: {
  target: RuntimeTarget;
  cacheDir: string;
  destination: string;
  /** Test seam: defaults to the pinned official distribution. */
  distBaseUrl?: string;
  /** Test seam: defaults to the pinned official Windows LICENSE source. */
  licenseUrl?: string;
  /** Test seam: defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam for Windows: fixtures served with their own pins. */
  files?: { exe: Required<PinnedFile>; license: Required<PinnedFile> };
}): Promise<void> {
  const { target, cacheDir, destination } = options;
  const distBase = options.distBaseUrl ?? `https://nodejs.org/dist/v${nodeVersion}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(cacheDir, { recursive: true });
  await mkdir(destination, { recursive: true });
  if (!isWindowsTarget(target)) {
    const archive = `node-v${nodeVersion}-${target}.tar.gz`;
    const archivePath = join(cacheDir, archive);
    await fetchPinned({
      url: `${distBase}/${archive}`,
      cachePath: archivePath,
      file: { sha256: archives[target] },
      fetchImpl,
    });
    await extract({
      file: archivePath,
      cwd: destination,
      strip: 1,
      filter: (path) => path.endsWith("/bin/node") || path.endsWith("/LICENSE"),
    });
    return;
  }
  const exe = options.files?.exe ?? windowsExes[target];
  const license = options.files?.license ?? windowsLicense;
  const exeCache = join(cacheDir, `node-v${nodeVersion}-${target}.exe`);
  // One LICENSE entry serves both architectures.
  const licenseCache = join(cacheDir, `node-v${nodeVersion}-LICENSE`);
  await fetchPinned({
    url: `${distBase}/win-${target.slice("win32-".length)}/node.exe`,
    cachePath: exeCache,
    file: exe,
    fetchImpl,
  });
  await fetchPinned({
    url:
      options.licenseUrl ?? `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
    cachePath: licenseCache,
    file: license,
    fetchImpl,
  });
  const exePath = runtimeNodePath(destination, "win32");
  const licensePath = join(destination, "LICENSE");
  await copyFile(exeCache, exePath);
  await copyFile(licenseCache, licensePath);
  if (!(await trusted(exePath, exe.sha256)))
    throw new Error("Untrusted staged Windows Node runtime");
  if (!(await trusted(licensePath, license.sha256)))
    throw new Error("Untrusted staged Windows Node LICENSE");
}
