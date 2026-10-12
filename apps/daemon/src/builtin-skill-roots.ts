import { lstat, mkdir, mkdtemp, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeProjection } from "@ace/plugins";
import { missingEntry } from "./project-picker-filesystem.ts";

const prefix = "session-";
const directory = (dataDir: string) => join(dataDir, "builtin-skill-sessions");

export async function createBuiltinSkillRoot(dataDir: string): Promise<string> {
  const base = directory(dataDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, prefix));
}

/** Capture before engine startup; recovery may create fresh sessions in the same directory. */
export async function builtinSkillRecovery(dataDir: string) {
  const base = directory(dataDir);
  const info = await lstat(base).catch((error: unknown) => {
    if (!missingEntry(error)) throw error;
    return undefined;
  });
  const roots: string[] = [];
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid skill session directory");
    const entries = await opendir(base);
    for await (const entry of entries) {
      if (entry.isDirectory() && /^session-[A-Za-z0-9]{6}$/.test(entry.name))
        roots.push(join(base, entry.name));
      // Bound cleanup per restart. Subsequent restarts can collect the remaining old roots.
      if (roots.length === 256) break;
    }
  }
  return async (
    providersRecovered: Promise<void>,
    report: (error: unknown) => void,
  ): Promise<void> => {
    await providersRecovered;
    for (const root of roots) {
      try {
        // The plugin writer validates ownership and refuses symlinks/unowned nonempty roots.
        await removeProjection(root);
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        report(error);
      }
    }
  };
}
