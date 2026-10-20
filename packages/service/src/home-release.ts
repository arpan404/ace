import { lstatSync, readFileSync, readlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { InstalledRelease, ReleaseDirectory } from "@ace/protocol";
import { renderLauncher } from "./launcher.ts";

/** Whether anything, a dangling pointer included, is at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The installation entries an `install.sh` home keeps beside its data. */
const installation = ["releases", "current", "previous", "bin"] as const;

/**
 * The version of the release installed in `backup` for `home`, or undefined when there is none
 * this build would run: its `current` pointer, release metadata and launcher must be exactly what
 * the installer writes for `home`, and no update may be half applied. Never runs anything.
 */
function carriedVersion(backup: string, home: string): string | undefined {
  try {
    if (present(join(backup, "update.json"))) return undefined;
    const target = ReleaseDirectory.parse(readlinkSync(join(backup, "current")));
    const release = InstalledRelease.parse(
      JSON.parse(readFileSync(join(backup, target, "release.json"), "utf8").slice(0, 16 * 1024)),
    );
    if (target !== `releases/${release.version}-${release.target}`) return undefined;
    // The launcher names the home it was installed for, so it is correct again once moved back.
    if (readFileSync(join(backup, "bin", "ace"), "utf8").slice(0, 8192) !== renderLauncher(home))
      return undefined;
    return release.version;
  } catch {
    return undefined;
  }
}

/**
 * After a fresh start, moves an installed release (its `releases`, `current` and `previous`
 * pointers and `bin/ace` launcher) from the backup into the fresh home, so an `install.sh`
 * install keeps working after a format bump. Each move is a rename within the same parent
 * directory. Returns the release's version, or undefined when the backup holds none.
 */
export function carryRelease(backup: string, home: string): string | undefined {
  const version = carriedVersion(backup, home);
  if (version === undefined) return undefined;
  for (const name of installation)
    if (present(join(backup, name)) && !present(join(home, name)))
      renameSync(join(backup, name), join(home, name));
  return version;
}
