import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extract } from "tar";
import type { z } from "zod";
import type { ReleaseTarget as ReleaseTargets } from "@ace/protocol";
import { downloadArchive, hashFile } from "@ace/service";

export type ReleaseTarget = z.infer<typeof ReleaseTargets>;

/**
 * The runtime ace ships beside its daemon (standalone archive and desktop app) is Bun. It is
 * installed under Node's old file names (`bin/node`, `node.exe`): launchers and updaters from
 * earlier releases run `<release>/bin/node ace.mjs`, and Bun runs scripts the same way under
 * that name.
 */
export const bunVersion = "1.4.4";
/** The Node release builds run on; native addons are built against its headers. */
export const nodeVersion = "26.12.1";

interface PinnedFile {
  /** Exact byte length; also the streaming download limit. */
  bytes: number;
  sha256: string;
}

/**
 * Bun's per-platform npm packages, pinned by the tarball's SHA-256. Their binaries are the
 * ones in Bun's GitHub release zips (checked against its SHASUMS256.txt for darwin-arm64). x64
 * uses the baseline builds, which need no AVX2, so every x64 machine Node ran on still starts.
 */
const packages: Record<ReleaseTarget, PinnedFile & { name: string }> = {
  "darwin-arm64": {
    name: "bun-darwin-aarch64",
    bytes: 41_545_333,
    sha256: "be5f17d636d699b2eaa2c1a8ac802c87f0815ccb5fe26cbe63d2395354ae5d0d",
  },
  "darwin-x64": {
    name: "bun-darwin-x64-baseline",
    bytes: 43_895_192,
    sha256: "1f4b4d1fa9e3b1dcb7890e4594703c7d5fac54c950964d89a2770760bc2cacbd",
  },
  "linux-arm64": {
    name: "bun-linux-aarch64",
    bytes: 53_132_992,
    sha256: "ab95e7e692a53d25a1baa98ee395a17f5f264aedfb3cb15811432d54142f70eb",
  },
  "linux-x64": {
    name: "bun-linux-x64-baseline",
    bytes: 52_418_564,
    sha256: "2ce69fadd00b741513c52adb8aad3fbee93170d0abaa3b6d04df47ca8659bd40",
  },
  "win32-x64": {
    name: "bun-windows-x64-baseline",
    bytes: 55_606_170,
    sha256: "ad1576a7c9a524b1dc377608c0bc16529c3f121f59c21aba981c019a528ff4fc",
  },
  "win32-arm64": {
    name: "bun-windows-aarch64",
    bytes: 50_843_293,
    sha256: "8cb207c5a3ed94289f46edcb36e640ed174d2117d14855dd9c4f45a4c4475677",
  },
};
/** Bun's LICENSE.md at the release tag: Bun's own MIT terms and its statically linked code. */
const license: PinnedFile = {
  bytes: 14_778,
  sha256: "362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd",
};

export type WindowsTarget = "win32-x64" | "win32-arm64";

export function isWindowsTarget(target: string): target is WindowsTarget {
  return target === "win32-x64" || target === "win32-arm64";
}

/** Where a release's runtime lives: `bin/node`, or `bin\node.exe` on Windows. */
export function releaseRuntimePath(root: string, target: ReleaseTarget): string {
  return join(root, "bin", isWindowsTarget(target) ? "node.exe" : "node");
}

async function trusted(path: string, sha256: string): Promise<boolean> {
  return hashFile(path).then(
    (hash) => hash === sha256,
    () => false,
  );
}

/**
 * Caches one pinned file. Stagings for several targets share the LICENSE entry, so a download
 * streams into a unique temp file and is published atomically once verified.
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

/**
 * Puts Bun for `target` at `executable` and its LICENSE at `licensePath`. Both downloads are
 * cached in `cacheDir` and used only while their SHA-256 matches the pin; otherwise they are
 * fetched again and verified before anything is unpacked.
 */
export async function stageBunRuntime(options: {
  target: ReleaseTarget;
  cacheDir: string;
  executable: string;
  licensePath: string;
  /** Test seams: the registry, LICENSE URL, fetch and the pins they serve. */
  registry?: string;
  licenseUrl?: string;
  fetchImpl?: typeof fetch;
  files?: { archive: PinnedFile; license: PinnedFile };
}): Promise<void> {
  const pinned = packages[options.target];
  const archive = options.files?.archive ?? pinned;
  const licenseFile = options.files?.license ?? license;
  const fetchImpl = options.fetchImpl ?? fetch;
  const archiveCache = join(options.cacheDir, `${pinned.name}-${bunVersion}.tgz`);
  const licenseCache = join(options.cacheDir, `bun-${bunVersion}-LICENSE.md`);
  await mkdir(options.cacheDir, { recursive: true });
  await fetchPinned(
    `${options.registry ?? "https://registry.npmjs.org"}/@oven/${pinned.name}/-/${pinned.name}-${bunVersion}.tgz`,
    archiveCache,
    archive,
    fetchImpl,
  );
  await fetchPinned(
    options.licenseUrl ??
      `https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`,
    licenseCache,
    licenseFile,
    fetchImpl,
  );
  const binary = isWindowsTarget(options.target) ? "package/bin/bun.exe" : "package/bin/bun";
  const unpacked = await mkdtemp(join(options.cacheDir, "bun-unpack-"));
  try {
    await extract({ file: archiveCache, cwd: unpacked, filter: (path) => path === binary });
    await mkdir(dirname(options.executable), { recursive: true });
    await copyFile(join(unpacked, binary), options.executable);
  } catch (error) {
    throw new Error(`The pinned Bun ${bunVersion} package has no ${binary}`, { cause: error });
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
  await chmod(options.executable, 0o755);
  await mkdir(dirname(options.licensePath), { recursive: true });
  await copyFile(licenseCache, options.licensePath);
  if (!(await trusted(options.licensePath, licenseFile.sha256)))
    throw new Error("Untrusted staged Bun LICENSE");
}
