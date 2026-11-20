import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { isMissing, ownDirectory } from "./files.ts";

/*
 * Each plugin launch projects into a directory of its own under the session root (ADR 0052's
 * "Stop always settles" made its cleanup bounded, so a late cleanup must only ever reach its own
 * files). A launch directory carries a marker naming its launch and a lock its launch holds for
 * as long as it lives; the lock is a SQLite write transaction, which the OS releases when the
 * process dies. Only marked directories whose lock is free are ever swept.
 */

const prefix = "launch-";
const markerName = ".ace-launch";
const lockName = "launch.sqlite";

export interface LaunchDirectory {
  readonly name: string;
  readonly path: string;
  /** The launch is over: its directory may be swept from now on. */
  release(): void;
}

/** Takes the directory's launch lock if no live launch holds it. */
function tryHold(path: string): DatabaseSync | undefined {
  const db = new DatabaseSync(join(path, lockName));
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    return db;
  } catch {
    db.close();
    return undefined;
  }
}

/** Whether `path` is a launch directory ace made for the launch `id`. */
async function markedFor(path: string, id: string): Promise<boolean> {
  try {
    const marker = join(path, markerName);
    if (!(await lstat(marker)).isFile()) return false;
    return (await readFile(marker, "utf8")) === id;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Makes the launch `id`'s directory under `root` and holds it: the directory, then its lock,
 * then its marker, so a directory is never marked before it is held.
 */
export async function claimLaunchDirectory(root: string, id: string): Promise<LaunchDirectory> {
  const name = `${prefix}${id}`;
  const path = await ownDirectory(join(root, name));
  const held = tryHold(path);
  if (!held) throw new Error("Plugin launch directory is already held");
  try {
    await writeFile(join(path, markerName), id, { flag: "wx", mode: 0o600 });
  } catch (error) {
    held.close();
    throw error;
  }
  let released = false;
  return {
    name,
    path,
    release() {
      if (released) return;
      released = true;
      held.close();
    },
  };
}

/**
 * Removes the launch directories under `root`, other than `current`, that ace made and no live
 * launch holds: each is taken under its own lock, which no live launch would give up, and its
 * marker is read again before it goes. Anything else there, unmarked, is never touched. Best
 * effort. `listed` runs between reading the root and acting on what it held.
 */
export async function sweepLaunchDirectories(
  root: string,
  current: string,
  listed: () => Promise<void> = async () => {},
): Promise<void> {
  const names = await readdir(root).catch(() => []);
  await listed();
  for (const name of names) {
    if (!name.startsWith(prefix) || name === current) continue;
    const id = name.slice(prefix.length);
    const path = join(root, name);
    try {
      if (!(await markedFor(path, id))) continue;
      const held = tryHold(path);
      if (!held) continue;
      try {
        if (await markedFor(path, id)) await rm(path, { recursive: true, force: true });
      } finally {
        held.close();
      }
    } catch {
      // One that can't be read or removed now is left for a later sweep.
    }
  }
}
