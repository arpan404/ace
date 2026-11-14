import { realpath, stat } from "node:fs/promises";

/**
 * A launcher this small can start a different CLI without changing itself (a version manager's
 * shim, a wrapper script), so its own file says nothing about the version it runs.
 */
const smallestCachedBytes = 64 * 1024;

/**
 * What each installed Claude CLI reported for `--version`, so a session open does not start the
 * CLI only to read it again. An entry belongs to one file: a new path, size, modification or
 * change time (an update, a reinstall, a replaced binary) reads the version again.
 */
export class CliVersions {
  #known = new Map<string, { file: string; output: string }>();

  async read(executable: string, probe: () => Promise<string>): Promise<string> {
    const path = await realpath(executable);
    const before = await fileIdentity(path);
    const known = this.#known.get(path);
    if (before && known?.file === before) return known.output;
    const output = await probe();
    // Only a file that held still while it answered describes the version it reported.
    if (before && (await fileIdentity(path)) === before) {
      if (this.#known.size >= 32) this.#known.clear();
      this.#known.set(path, { file: before, output });
    }
    return output;
  }
}

async function fileIdentity(path: string): Promise<string | undefined> {
  const info = await stat(path, { bigint: true });
  if (!info.isFile() || info.size < smallestCachedBytes) return undefined;
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
