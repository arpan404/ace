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
export const nodeVersion = "24.13.0";
/** Pinned from the official Node release SHASUMS256.txt. */
const hashes: Record<ReleaseTarget, string> = {
  "darwin-arm64": "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
  "darwin-x64": "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
  "linux-arm64": "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
  "linux-x64": "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
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
/** Pinned from the official Node v24.13.0 SHASUMS256.txt and the v24.13.0 source tag. */
const windowsExes: Record<WindowsTarget, PinnedFile> = {
  "win32-x64": {
    bytes: 89_953_280,
    sha256: "d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11",
  },
  "win32-arm64": {
    bytes: 79_135_232,
    sha256: "91e25b2ef61ee30a9e6afce0f336b4d55d688c3717244e496fa11d69fc3a1717",
  },
};
const windowsLicense: PinnedFile = {
  bytes: 143_310,
  sha256: "537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34",
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
