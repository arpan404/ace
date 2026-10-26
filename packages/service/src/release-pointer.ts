import { readlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ReleaseDirectory } from "@ace/protocol";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";

/** Windows installs need no directory-symlink privilege. Read the pointer itself
 * through a bounded no-follow descriptor, never through its contents as a path.
 */
export function readReleasePointerSync(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return readlinkSync(path);
  const parent = PinnedDirectory.atBoundary(dirname(path));
  try {
    return ReleaseDirectory.parse(parent.readText(basename(path), 512));
  } finally {
    parent.closeSync();
  }
}

/** Staged private bytes are flushed before publication. This promises atomic
 * visibility, not directory durability across a Windows power failure.
 */
export function writeReleasePointer(path: string, target: string): void {
  const destination = ReleaseDirectory.parse(target);
  const parent = PinnedDirectory.atBoundary(dirname(path));
  try {
    parent.replace(basename(path), destination);
  } finally {
    parent.closeSync();
  }
}
