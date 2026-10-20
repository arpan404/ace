import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { InstalledRelease, ReleaseDirectory } from "@ace/protocol";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { isDesktopShim, renderLauncher } from "./launcher.ts";
export { CLI_SHIM_MARKER, isDesktopShim, renderLauncher } from "./launcher.ts";
import { assertTestHomeIsolation } from "./test-home-guard.ts";

export {
  HOME_FORMAT_FILE,
  HOME_FORMAT_VERSION,
  LiveHomeError,
  OldAceRunningError,
  NewerDataError,
  formatName,
} from "./home-format.ts";
export { prepareDaemonHome, type FreshStartPorts, type PreparedHome } from "./home-fresh-start.ts";
export { claimHome, processAlive, type HomeClaim } from "./home-claim.ts";
export { BACKUP_README, describeBackup } from "./home-backup.ts";

/**
 * The ace data home: `ACE_HOME` when set, otherwise `~/.ace` (ADR 0081). This only names the
 * path. Whatever writes into the home first runs `prepareDaemonHome`, which creates it or gives
 * it a fresh start. `~/.ace-next`, used by interim builds, is never read.
 */
export function resolveDaemonHome(home: string, requested?: string): string {
  assertTestHomeIsolation(home);
  const root = requested === undefined ? join(resolve(home), ".ace") : resolve(requested);
  assertTestHomeIsolation(root);
  return root;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function desktopShimAt(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && stats.size <= 4096 && isDesktopShim(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Refuses a home whose installed launcher or release pointer is not this rewrite's validated
 * installation, before any service manager is asked about it or any binary of it runs.
 */
export function assertCompatibleHome(root: string): void {
  assertTestHomeIsolation(root);
  // The desktop app's own `ace` command is not an installation; a home with only that is fine.
  if (!present(join(root, "current")) && desktopShimAt(join(root, "bin", "ace"))) return;
  if (present(join(root, "bin", "ace")) || present(join(root, "current"))) installedVersion(root);
}

/** Inspect metadata only. Never execute a binary to discover whether it is legacy. */
export function installedVersion(root: string): string {
  const directories: PinnedDirectory[] = [];
  try {
    const home = PinnedDirectory.atBoundary(root);
    directories.push(home);
    const target = ReleaseDirectory.parse(readlinkSync(join(root, "current")));
    if (!home.matchesBoundary(root)) throw new Error("Home changed during validation");
    const releases = home.child("releases");
    directories.push(releases);
    const generation = releases.child(target.slice("releases/".length));
    directories.push(generation);
    const release = InstalledRelease.parse(
      JSON.parse(generation.readText("release.json", 16 * 1024)),
    );
    if (target !== `releases/${release.version}-${release.target}`)
      throw new Error("Release metadata does not match its directory");
    const bin = home.child("bin");
    directories.push(bin);
    if (bin.readText("ace", 8192) !== renderLauncher(root))
      throw new Error("Launcher differs from the complete validated program");
    return release.version;
  } catch (cause) {
    throw new Error(
      `Incompatible or legacy ace installation at ${root}. Refusing to execute or adopt its binary/service.`,
      { cause },
    );
  } finally {
    for (const directory of directories.toReversed()) directory.closeSync();
  }
}
