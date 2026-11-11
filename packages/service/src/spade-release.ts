import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ReleaseVersion } from "@ace/protocol";
import { atomicPointer, pointer, retrySharing, syncDirectory } from "./files.ts";
import { spadeBinaryName } from "./spade-plan.ts";

/**
 * Spade's installed binaries (ADR 0123): `<ACE_HOME>/releases/spade/<version>/spade-server`
 * behind a `current` pointer the service runs. Like the daemon's releases, nothing here
 * follows a link: a link where a folder or the binary belongs is refused.
 */
export const spadeReleases = (home: string) => join(home, "releases", "spade");

/** Refuses anything at `path` other than a real folder; false when nothing is there. */
async function realDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory()) throw new Error(`Refusing ${path}: not a plain folder`);
  return true;
}

async function regularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Refusing ${path}: not a plain file`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function flush(path: string): Promise<void> {
  // Windows flushes only through a writable handle.
  const file = await open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * Copies `source` to `releases/spade/<version>/` without touching `current`: the updater
 * checks the copy before it flips. A folder already holding the same bytes is kept, so a
 * running Spade's binary is never rewritten under it.
 */
export async function stageSpadeBinary(
  home: string,
  source: string,
  version: string,
): Promise<string> {
  const release = ReleaseVersion.parse(version);
  await regularFile(source);
  await realDirectory(home);
  const releases = join(home, "releases");
  if (!(await realDirectory(releases))) await mkdir(releases, { recursive: true, mode: 0o700 });
  const root = spadeReleases(home);
  if (!(await realDirectory(root))) await mkdir(root, { mode: 0o700 });
  const name = spadeBinaryName(process.platform);
  const folder = join(root, release);
  if (await realDirectory(folder)) {
    const existing = join(folder, name);
    await regularFile(existing);
    if ((await sha256(existing)) === (await sha256(source))) return folder;
    await retrySharing(() => rm(folder, { recursive: true, force: true }));
  }
  const staging = join(root, `.staging-${release}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  await copyFile(source, join(staging, name));
  const file = await open(join(staging, name), "r");
  await file.chmod(0o755).finally(() => file.close());
  await flush(join(staging, name));
  await syncDirectory(staging);
  await retrySharing(() => rename(staging, folder));
  await syncDirectory(root);
  return folder;
}

/** Points `releases/spade/current` at `version`, atomically. */
export async function flipSpadeCurrent(home: string, version: string): Promise<void> {
  const release = ReleaseVersion.parse(version);
  const folder = join(spadeReleases(home), release);
  if (!(await realDirectory(folder))) throw new Error(`Spade ${release} is not installed`);
  await regularFile(join(folder, spadeBinaryName(process.platform)));
  await atomicPointer(join(spadeReleases(home), "current"), release);
}

/**
 * The version `releases/spade/current` names, or undefined when Spade's binary was never
 * installed. A pointer that names anything but a plain version folder holding the binary is
 * refused, never followed.
 */
export async function installedSpadeVersion(home: string): Promise<string | undefined> {
  const root = spadeReleases(home);
  if (!(await realDirectory(join(home, "releases"))) || !(await realDirectory(root)))
    return undefined;
  const target = await pointer(join(root, "current"));
  if (target === undefined) return undefined;
  const version = ReleaseVersion.safeParse(target);
  if (!version.success) throw new Error(`Refusing Spade's current pointer: ${target}`);
  if (!(await realDirectory(join(root, version.data))))
    throw new Error(`Spade's current pointer names a missing release: ${version.data}`);
  await regularFile(join(root, version.data, spadeBinaryName(process.platform)));
  return version.data;
}

/** Copies `source` in as `version` and makes it current: the install path's whole job. */
export async function installSpadeBinary(
  home: string,
  source: string,
  version: string,
): Promise<string> {
  const folder = await stageSpadeBinary(home, source, version);
  const previous = await installedSpadeVersion(home).catch(() => undefined);
  await flipSpadeCurrent(home, version);
  await pruneSpadeReleases(home, [version, ...(previous ? [previous] : [])]);
  return folder;
}

/**
 * Removes every Spade release but `keep`. Best effort: Windows can't delete a binary that is
 * still running, so what stays is retried by the next install.
 */
export async function pruneSpadeReleases(home: string, keep: readonly string[]): Promise<void> {
  const root = spadeReleases(home);
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name === "current" || name.startsWith("current.") || keep.includes(name)) continue;
    await retrySharing(() => rm(join(root, name), { recursive: true, force: true })).catch(
      () => {},
    );
  }
}
