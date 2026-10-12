import { lstat, mkdir, mkdtemp, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeProjection } from "@ace/plugins";
import { PinnedDirectory } from "@ace/workspace";
import { missingEntry } from "./project-picker-filesystem.ts";
import {
  builtinSkillRootUnused,
  skillProcessRuntime,
  type SkillProcessRuntime,
} from "./builtin-skill-processes.ts";

const prefix = "session-";
const pattern = /^session-[A-Za-z0-9]{6}$/;
const cursorName = ".cursor";
export const builtinSkillSessionsDirectory = "builtin-skill-sessions";
const sessionsPath = (dataDir: string) => join(dataDir, builtinSkillSessionsDirectory);

/** Per-start work: reclamations are bounded separately from lease inspections. */
const limits = { removals: 64, inspections: 1024 };

export function isBuiltinSkillRootName(name: string): boolean {
  return pattern.test(name);
}

export async function createBuiltinSkillRoot(dataDir: string): Promise<string> {
  const base = sessionsPath(dataDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, prefix));
}

/** Anything ace could have left at a cursor name: a file, a link or an empty directory. */
function discard(directory: PinnedDirectory, name: string): void {
  try {
    directory.unlink(name);
  } catch {
    try {
      directory.removeDirectory(name);
    } catch {
      // A nonempty directory was not written by ace. The next write reports it.
    }
  }
}
/**
 * The last inspected root name. The cursor must be a private, singly linked regular file
 * owned by this user. Anything else is discarded and rotation restarts from the beginning.
 */
export function readSkillCursor(directory: PinnedDirectory, file: string): string | undefined {
  let text: string;
  try {
    text = directory.readText(file, 64, process.getuid?.());
  } catch (error) {
    if (missingEntry(error)) return undefined;
    discard(directory, file);
    return undefined;
  }
  if (pattern.test(text)) return text;
  discard(directory, file);
  return undefined;
}
/** Atomic replacement; a broken cursor or stale temporary is cleared and the write retried once. */
export function writeSkillCursor(directory: PinnedDirectory, file: string, name: string): void {
  try {
    directory.replace(file, name);
  } catch {
    discard(directory, file);
    discard(directory, `${file}.pending`);
    directory.replace(file, name);
  }
}

/** Sorted snapshot names in inspection order, starting after the cursor and wrapping once. */
export function rotateSkillRoots(names: readonly string[], cursor: string | undefined): string[] {
  const start = cursor === undefined ? 0 : names.findIndex((name) => name > cursor);
  const from = start === -1 ? 0 : start;
  return [...names.slice(from), ...names.slice(0, from)];
}

/** Capture before engine startup; recovery may create fresh sessions in the same directory. */
export async function builtinSkillRecovery(
  dataDir: string,
  runtime: SkillProcessRuntime = skillProcessRuntime,
) {
  const base = sessionsPath(dataDir);
  const info = await lstat(base).catch((error: unknown) => {
    if (!missingEntry(error)) throw error;
    return undefined;
  });
  const names: string[] = [];
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid skill session directory");
    // Names only: every root present now is eligible; roots created later never are.
    for await (const entry of await opendir(base))
      if (entry.isDirectory() && pattern.test(entry.name)) names.push(entry.name);
    names.sort();
  }
  return async (
    providersRecovered: Promise<void>,
    report: (error: unknown) => void,
  ): Promise<void> => {
    await providersRecovered;
    if (!names.length) return;
    let pinned: PinnedDirectory;
    try {
      pinned = PinnedDirectory.atBoundary(base);
    } catch (error) {
      report(error);
      return;
    }
    try {
      const order = rotateSkillRoots(names, readSkillCursor(pinned, cursorName));
      const last = await collect(base, order, runtime, report);
      if (last) writeSkillCursor(pinned, cursorName, last);
    } catch (error) {
      report(error);
    } finally {
      pinned.closeSync();
    }
  };
}

/** Returns the last inspected name. Retained roots cost an inspection, so they cannot starve later ones. */
async function collect(
  base: string,
  order: readonly string[],
  runtime: SkillProcessRuntime,
  report: (error: unknown) => void,
): Promise<string | undefined> {
  let inspected = 0;
  let removed = 0;
  let last: string | undefined;
  for (const name of order) {
    if (inspected >= limits.inspections || removed >= limits.removals) break;
    inspected += 1;
    last = name;
    const root = join(base, name);
    try {
      if (!builtinSkillRootUnused(root, runtime)) continue;
      // The plugin writer validates ownership and refuses symlinks/unowned nonempty roots.
      await removeProjection(root);
      await rm(root, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      report(error);
    }
  }
  return last;
}
