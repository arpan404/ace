import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { extract } from "tar";
import type { z } from "zod";
import type { ReleaseTarget as ReleaseTargets } from "@ace/protocol";
import { downloadArchive, hashFile } from "@ace/service";

export type ReleaseTarget = z.infer<typeof ReleaseTargets>;

/** The Node runtime ace ships beside its daemon (standalone archive and desktop app). */
export const nodeVersion = "26.12.1";
/** Pinned from the official Node release SHASUMS256.txt. */
const hashes: Record<ReleaseTarget, string> = {
  "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
  "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
  "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
  "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  // Windows has no Node archive here: stageWindowsNodeRuntime pins the raw node.exe instead.
  "win32-x64": "",
  "win32-arm64": "",
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
  if (isWindowsTarget(target)) return stageWindowsArchiveRuntime(target, options);
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

// Windows builds (desktop and standalone) ship the raw official node.exe and the tagged LICENSE
// (no zip).
export type WindowsTarget = "win32-x64" | "win32-arm64";

export function isWindowsTarget(target: string): target is WindowsTarget {
  return target === "win32-x64" || target === "win32-arm64";
}

interface PinnedFile {
  /** Exact byte length; also the streaming download limit. */
  bytes: number;
  sha256: string;
}
/** Pinned from the official Node v26.12.1 SHASUMS256.txt and the v26.12.1 source tag. */
const windowsExes: Record<WindowsTarget, PinnedFile> = {
  "win32-x64": {
    bytes: 105_319_752,
    sha256: "1c63f1417e2e26d83ca9a9ec1d548524ab1305bc7209d90ebca56257ff0d84ed",
  },
  "win32-arm64": {
    bytes: 91_382_600,
    sha256: "7384299eeb99f419acaa4142771689fbca72e1c942f8da02b7928ffe1744e3ff",
  },
};
const windowsLicense: PinnedFile = {
  bytes: 156_386,
  sha256: "8e603aa87c70d36e497004f0dec63111511cb61b7d65ace12e10ea791599286c",
};

/** The staged Windows Node executable inside a `runtime/` directory. */
export function windowsNodePath(destination: string): string {
  return join(destination, "node.exe");
}

async function trusted(path: string, sha256: string): Promise<boolean> {
  return hashFile(path).then(
    (hash) => hash === sha256,
    () => false,
  );
}

/**
 * Caches one pinned file. Stagings for both architectures share the LICENSE entry, so a
 * download streams into a unique temp file and is published atomically once verified.
 */
async function fetchPinned(
  url: string,
  cachePath: string,
  file: PinnedFile,
  fetchImpl: typeof fetch,
) {
  if (await trusted(cachePath, file.sha256)) return;
  const tempPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    await downloadArchive(response, tempPath, file);
    if (!(await trusted(cachePath, file.sha256))) await rename(tempPath, cachePath);
  } catch (error) {
    // A concurrent staging may have published the same verified file.
    if (!(await trusted(cachePath, file.sha256))) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
  await rm(tempPath, { force: true });
}

/** Puts `node.exe` and Node's `LICENSE` for a Windows target into `destination`. */
export async function stageWindowsNodeRuntime(options: {
  target: WindowsTarget;
  cacheDir: string;
  destination: string;
  /** Test seams: the distribution base, LICENSE URL, fetch and the pins they serve. */
  distBaseUrl?: string;
  licenseUrl?: string;
  fetchImpl?: typeof fetch;
  files?: { exe: PinnedFile; license: PinnedFile };
}): Promise<void> {
  const { target, cacheDir, destination } = options;
  const exe = options.files?.exe ?? windowsExes[target];
  const license = options.files?.license ?? windowsLicense;
  const fetchImpl = options.fetchImpl ?? fetch;
  const exeCache = join(cacheDir, `node-v${nodeVersion}-${target}.exe`);
  const licenseCache = join(cacheDir, `node-v${nodeVersion}-LICENSE`);
  await mkdir(cacheDir, { recursive: true });
  await fetchPinned(
    `${options.distBaseUrl ?? `https://nodejs.org/dist/v${nodeVersion}`}/win-${target.slice(6)}/node.exe`,
    exeCache,
    exe,
    fetchImpl,
  );
  await fetchPinned(
    options.licenseUrl ?? `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
    licenseCache,
    license,
    fetchImpl,
  );
  await mkdir(destination, { recursive: true });
  await copyFile(exeCache, windowsNodePath(destination));
  await copyFile(licenseCache, join(destination, "LICENSE"));
  if (!(await trusted(windowsNodePath(destination), exe.sha256)))
    throw new Error("Untrusted staged Windows Node runtime");
  if (!(await trusted(join(destination, "LICENSE"), license.sha256)))
    throw new Error("Untrusted staged Windows Node LICENSE");
}

/** The standalone Windows archive keeps Node as `bin\\node.exe` and its LICENSE at the top. */
async function stageWindowsArchiveRuntime(
  target: WindowsTarget,
  options: { cacheDir: string; destination: string },
): Promise<void> {
  const bin = join(options.destination, "bin");
  await stageWindowsNodeRuntime({ target, cacheDir: options.cacheDir, destination: bin });
  await rename(join(bin, "LICENSE"), join(options.destination, "LICENSE"));
}
