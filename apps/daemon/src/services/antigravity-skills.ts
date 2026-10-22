import { lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * The person's own skills in an added Antigravity account. The agent reads user-global skills
 * from `<GEMINI_HOME>/config/skills` and `<GEMINI_HOME>/antigravity-cli/skills`, so an account
 * in its own home would otherwise lose them. Only those two folders are linked back: the
 * person's MCP servers, hooks and settings stay out of the account.
 */
const skillFolders = [
  ["config", "skills"],
  ["antigravity-cli", "skills"],
] as const;

/**
 * Links an account home's skill folders to the person's. A folder the account already has of
 * its own is left alone; a link to somewhere else is pointed back at the person's folder. Work
 * happens only under real folders inside the account home: a linked `config` could otherwise
 * lead the change into the person's own folders.
 */
export async function linkPersonalSkills(accountHome: string, personal: string): Promise<void> {
  const home = await realpath(accountHome);
  for (const folder of skillFolders) {
    const parent = join(accountHome, folder[0]);
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    const found = await lstat(parent);
    if (
      !found.isDirectory() ||
      found.isSymbolicLink() ||
      (await realpath(parent)) !== join(home, folder[0])
    )
      continue;
    const link = join(parent, folder[1]);
    const target = join(personal, ...folder);
    const existing = await lstat(link).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && !existing.isSymbolicLink()) continue;
    if (existing && (await readlink(link)) === target) continue;
    if (existing) await rm(link);
    await symlink(target, link, "dir");
  }
}
