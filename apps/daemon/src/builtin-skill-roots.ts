import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, mkdtemp, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeProjection } from "@ace/plugins";
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
const directory = (dataDir: string) => join(dataDir, builtinSkillSessionsDirectory);

/** Per-start work: reclamations are bounded separately from lease inspections. */
const limits = { removals: 64, inspections: 1024 };

export function isBuiltinSkillRootName(name: string): boolean {
  return pattern.test(name);
}

export async function createBuiltinSkillRoot(dataDir: string): Promise<string> {
  const base = directory(dataDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, prefix));
}

/** The last inspected name. A missing, foreign or malformed cursor restarts from the beginning. */
function readCursor(base: string): string | undefined {
  let file: number;
  try {
    file = openSync(join(base, cursorName), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missingEntry(error)) return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 64 || stat.uid !== process.getuid?.())
      throw new Error("Invalid skill session cursor");
    const name = readFileSync(file, "utf8");
    if (!pattern.test(name)) throw new Error("Invalid skill session cursor");
    return name;
  } finally {
    closeSync(file);
  }
}
/** Replaces the cursor entry itself; rename never follows a planted link. */
function writeCursor(base: string, name: string): void {
  const temporary = join(base, `${cursorName}.next`);
  const file = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(file, name);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, join(base, cursorName));
}

/** Sorted snapshot names in inspection order, starting after the cursor and wrapping once. */
function rotateSkillRoots(names: readonly string[], cursor: string | undefined): string[] {
  const start = cursor === undefined ? 0 : names.findIndex((name) => name > cursor);
  const from = start === -1 ? 0 : start;
  return [...names.slice(from), ...names.slice(0, from)];
}

/** Capture before engine startup; recovery may create fresh sessions in the same directory. */
export async function builtinSkillRecovery(
  dataDir: string,
  runtime: SkillProcessRuntime = skillProcessRuntime,
) {
  const base = directory(dataDir);
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
    let cursor: string | undefined;
    try {
      cursor = readCursor(base);
    } catch (error) {
      report(error);
    }
    let inspected = 0;
    let removed = 0;
    let last: string | undefined;
    // Retained roots cost an inspection, so a permanently retained prefix cannot starve later roots.
    for (const name of rotateSkillRoots(names, cursor)) {
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
    try {
      if (last) writeCursor(base, last);
    } catch (error) {
      report(error);
    }
  };
}
