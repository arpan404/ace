import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { extract } from "tar";
import type { z } from "zod";
import type { ReleaseTarget as ReleaseTargets } from "@ace/protocol";
import { downloadArchive, hashFile } from "@ace/service";
import {
  nodeDistBaseUrl,
  nodeLicenseUrl,
  windowsNodeCacheNames,
  windowsNodeExeFiles,
  windowsNodeLicenseFile,
  windowsRuntimePaths,
  type PinnedRuntimeFile,
  type WindowsDesktopRuntimeTarget,
} from "./windows-node-files.ts";

export { windowsRuntimePaths };
export type { WindowsDesktopRuntimeTarget } from "./windows-node-files.ts";

export type ReleaseTarget = z.infer<typeof ReleaseTargets>;

/** The Node runtime ace ships beside its daemon (standalone archive and desktop app). */
export const nodeVersion = "24.13.0";
/** Pinned from the official Node release SHASUMS256.txt. */
const hashes: Record<ReleaseTarget, string> = {
  "darwin-arm64": "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
  "darwin-x64": "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
  "linux-arm64": "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
  "linux-x64": "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
};

/**
 * Puts `bin/node` and Node's `LICENSE` for `target` into `destination`. The official archive
 * is cached in `cacheDir` and used only while its SHA-256 matches the pin; otherwise it is
 * downloaded again and verified before extraction.
 */
export async function stageNodeRuntime(options: {
  target: ReleaseTarget;
  version: string;
  cacheDir: string;
  destination: string;
}): Promise<void> {
  const { target, cacheDir } = options;
  const archive = `node-v${nodeVersion}-${target}.tar.gz`;
  const archivePath = join(cacheDir, archive);
  try {
    if ((await hashFile(archivePath)) !== hashes[target])
      throw new Error("Untrusted cached Node runtime");
  } catch {
    await rm(archivePath, { force: true });
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archive}`, {
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = Number(response.headers.get("content-length"));
    await downloadArchive(response, archivePath, {
      version: options.version,
      target,
      channel: "stable",
      archive: "ace-node.tar.gz",
      bytes,
      sha256: hashes[target],
    });
  }
  await extract({
    file: archivePath,
    cwd: options.destination,
    strip: 1,
    filter: (path) => path.endsWith("/bin/node") || path.endsWith("/LICENSE"),
  });
}

/**
 * Downloads one pinned file into the cache, reusing the cached copy only while its
 * SHA-256 matches the pin. Concurrent stagings share the LICENSE cache entry, so the
 * cache is never removed in place: the download streams into a unique temp file through
 * `downloadArchive` (which caps bytes at the pinned length and rejects checksum
 * mismatches), then the verified temp file is published atomically. A failed download
 * removes only its temp file and never leaves a partial cache entry; a lost publish
 * race reuses the winner's verified cache. The fetch itself times out. No shell, no
 * extraction, no credentials.
 */
async function fetchPinnedRuntimeFile(options: {
  url: string;
  cachePath: string;
  file: PinnedRuntimeFile;
  fetchImpl: typeof fetch;
}): Promise<void> {
  try {
    if ((await hashFile(options.cachePath)) === options.file.sha256) return;
  } catch {
    // Missing or unreadable cache falls through to a verified download. A hash
    // mismatch also falls through: it just means the cache needs refresh.
  }
  const tempPath = `${options.cachePath}.${randomUUID()}.tmp`;
  try {
    const response = await options.fetchImpl(options.url, {
      signal: AbortSignal.timeout(120_000),
    });
    await downloadArchive(response, tempPath, {
      bytes: options.file.bytes,
      sha256: options.file.sha256,
    });
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    try {
      if ((await hashFile(options.cachePath)) === options.file.sha256) return;
    } catch {
      // Cache is still missing or untrusted; report the download failure.
    }
    throw error;
  }
  try {
    if ((await hashFile(options.cachePath)) === options.file.sha256) {
      await rm(tempPath, { force: true });
      return;
    }
  } catch {
    // Cache is still missing or untrusted; publish the verified temp file below.
  }
  try {
    await rename(tempPath, options.cachePath);
  } catch {
    try {
      if ((await hashFile(options.cachePath)) === options.file.sha256) {
        await rm(tempPath, { force: true }).catch(() => {});
        return;
      }
    } catch {
      // Cache is still unusable; fall through to report the publish failure.
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw new Error("Windows Node runtime cache publication lost its verified file");
  }
}

/**
 * Puts `node.exe` and Node's `LICENSE` for a Windows desktop target into
 * `destination` (a `runtime/` directory). The official raw `node.exe` and the pinned
 * matching `LICENSE` are cached in `cacheDir` and used only while their SHA-256
 * matches the pin; otherwise each is downloaded again and verified before staging.
 *
 * The staged executable path is owned by `windowsRuntimePaths`: `runtime/node.exe`.
 * This is only the runtime staging foundation for win32 desktop builds. It does not
 * make the full Windows installer work: the desktop still runs no local daemon on
 * Windows, and the daemon bundler has other blockers. Standalone updater/archive
 * support for Windows targets is future work.
 */
export async function stageWindowsNodeRuntime(options: {
  target: WindowsDesktopRuntimeTarget;
  cacheDir: string;
  destination: string;
  /** Test seam: defaults to the pinned official distribution base. */
  distBaseUrl?: string;
  /** Test seam: defaults to the pinned official LICENSE source. */
  licenseUrl?: string;
  /** Test seam: defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: defaults to the pinned files; tests serve fixtures with matching pins. */
  files?: { exe: PinnedRuntimeFile; license: PinnedRuntimeFile };
}): Promise<void> {
  const { target, cacheDir, destination } = options;
  const exeMeta = windowsNodeExeFiles[target];
  const exeFile = options.files?.exe ?? exeMeta;
  const licenseFile = options.files?.license ?? windowsNodeLicenseFile;
  const distBase = options.distBaseUrl ?? nodeDistBaseUrl(nodeVersion);
  const licenseSource = options.licenseUrl ?? nodeLicenseUrl(nodeVersion);
  const fetchImpl = options.fetchImpl ?? fetch;
  const names = windowsNodeCacheNames(nodeVersion, target);
  const exeCache = join(cacheDir, names.exe);
  const licenseCache = join(cacheDir, names.license);
  await mkdir(cacheDir, { recursive: true });
  await fetchPinnedRuntimeFile({
    url: `${distBase}/${exeMeta.distPath}`,
    cachePath: exeCache,
    file: exeFile,
    fetchImpl,
  });
  await fetchPinnedRuntimeFile({
    url: licenseSource,
    cachePath: licenseCache,
    file: licenseFile,
    fetchImpl,
  });
  const staged = windowsRuntimePaths(destination);
  await mkdir(destination, { recursive: true });
  await copyFile(exeCache, staged.exePath);
  await copyFile(licenseCache, staged.licensePath);
  if ((await hashFile(staged.exePath)) !== exeFile.sha256)
    throw new Error("Untrusted staged Windows Node runtime");
  if ((await hashFile(staged.licensePath)) !== licenseFile.sha256)
    throw new Error("Untrusted staged Windows Node LICENSE");
}
