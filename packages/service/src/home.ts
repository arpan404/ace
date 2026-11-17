import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { InstalledRelease, ReleaseDirectory } from "@ace/protocol";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { isDesktopShim, renderLauncher } from "./launcher.ts";
import { CMD_LAUNCHER } from "./launcher.ts";
import { pointerText } from "./files.ts";
export { CLI_SHIM_MARKER, isDesktopShim, renderLauncher } from "./launcher.ts";
import { assertTestHomeIsolation } from "./test-home-guard.ts";

export {
  HOME_FORMAT_FILE,
  HOME_FORMAT_VERSION,
  LiveHomeError,
  OldAceRunningError,
  NewerDataError,
  formatName,
  markerVersion,
} from "./home-format.ts";
export { prepareDaemonHome, type FreshStartPorts, type PreparedHome } from "./home-fresh-start.ts";
export { claimHome, processAlive, type HomeClaim } from "./home-claim.ts";
export { BACKUP_README, describeBackup } from "./home-backup.ts";

export { resolveDaemonHome } from "./home-path.ts";

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
  if (process.platform === "win32") return assertCompatibleCmdHome(root);
  // The desktop app's own `ace` command is not an installation; a home with only that is fine.
  if (!present(join(root, "current")) && desktopShimAt(join(root, "bin", "ace"))) return;
  if (present(join(root, "bin", "ace")) || present(join(root, "current"))) installedVersion(root);
}

/** Inspect metadata only. Never execute a binary to discover whether it is legacy. */
export function installedVersion(root: string): string {
  if (process.platform === "win32") return installedPointerVersion(root);
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

/** Windows: `bin\\ace.cmd` is the launcher (the desktop app's shim has the same name). */
function assertCompatibleCmdHome(root: string): void {
  const launcher = join(root, "bin", CMD_LAUNCHER);
  if (!present(join(root, "current")) && desktopShimAt(launcher)) return;
  if (present(launcher) || present(join(root, "current"))) installedVersion(root);
}

/** `installedVersion` for Windows homes, whose `current` is a pointer file (ADR 0095). */
function installedPointerVersion(root: string): string {
  const directories: PinnedDirectory[] = [];
  try {
    const home = PinnedDirectory.atBoundary(root);
    directories.push(home);
    const target = ReleaseDirectory.parse(pointerText(home.readText("current", 256)));
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
    if (bin.readText(CMD_LAUNCHER, 8192) !== renderLauncher(root))
      throw new Error("Launcher differs from the complete validated program");
    return release.version;
  } catch (cause) {
    throw new Error(
      `Incompatible or legacy ace installation at ${root} (${cause instanceof Error ? cause.message : "invalid"}). Refusing to execute or adopt its binary/service.`,
      { cause },
    );
  } finally {
    for (const directory of directories.toReversed()) directory.closeSync();
  }
}
