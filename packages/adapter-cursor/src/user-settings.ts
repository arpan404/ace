import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

/**
 * The person's user-level Cursor configuration the SDK reads from `~/.cursor` (SDK 1.0.35:
 * MCP servers, hooks, rules, skills, plugins, commands and agents). Nothing here is a
 * credential: `sdk/` (the SDK's auth store), `cli-config.json` and every other entry stay out.
 */
export const cursorUserConfigEntries = [
  "mcp.json",
  "hooks.json",
  "rules",
  "skills",
  "skills-cursor",
  "plugins",
  "commands",
  "agents",
] as const;

export interface MirrorLimits {
  /** Files and directories copied per entry. */
  maxEntries: number;
  /** Bytes copied per entry. */
  maxBytes: number;
}
const defaultLimits: MirrorLimits = { maxEntries: 8192, maxBytes: 64 * 1024 * 1024 };

export interface MirrorResult {
  copied: string[];
  /** Entries left out, with the reason: over budget or unreadable. */
  skipped: { entry: string; reason: string }[];
}

class OverBudget extends Error {}

/**
 * Copy the person's user-level Cursor configuration from their real home into ace's private
 * per-instance home (ADR 0043), so the SDK loads it while its credential store stays private.
 * The real `~/.cursor` is only read: these are copies, never links, so nothing the SDK writes
 * reaches it. Each call replaces the previous copies, so removed config disappears too.
 * Nested symbolic links are not followed.
 */
export async function mirrorCursorUserConfig(
  userHome: string,
  privateHome: string,
  limits: MirrorLimits = defaultLimits,
): Promise<MirrorResult> {
  const source = join(userHome, ".cursor");
  const target = join(privateHome, ".cursor");
  const result: MirrorResult = { copied: [], skipped: [] };
  const real = await realpath(source).catch(() => undefined);
  if (!real) {
    for (const entry of cursorUserConfigEntries) await rm(join(target, entry), forced);
    return result;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const privateReal = await realpath(target);
  // A home that is (or contains) the private one would copy ace's state onto itself.
  if (inside(privateReal, real) || inside(real, privateReal)) return result;
  // A copy interrupted by a crash leaves a staging directory behind; never let them pile up.
  for (const name of await readdir(target))
    if (name.startsWith(stagingPrefix)) await rm(join(target, name), forced);
  const staging = await mkdtemp(join(target, stagingPrefix));
  try {
    for (const entry of cursorUserConfigEntries) {
      const from = join(real, entry);
      const staged = join(staging, entry);
      const kind = await stat(from).catch(() => undefined);
      if (kind && (kind.isFile() || kind.isDirectory())) {
        try {
          await copyTree(from, staged, kind.isDirectory(), { entries: 0, bytes: 0 }, limits);
        } catch (error) {
          await rm(staged, forced);
          result.skipped.push({
            entry,
            reason: error instanceof OverBudget ? "over size limit" : "unreadable",
          });
          continue;
        }
      }
      // Swap in the fresh copy, or remove a stale one whose source is gone.
      await rm(join(target, entry), forced);
      if (kind && (kind.isFile() || kind.isDirectory())) {
        await rename(staged, join(target, entry));
        result.copied.push(entry);
      }
    }
  } finally {
    await rm(staging, forced);
  }
  return result;
}

/**
 * Add ace's shipped skills (`<name>/SKILL.md` folders) to the private home's `.cursor/skills`,
 * after the person's own skills were mirrored there. A skill the person already has under the
 * same name is theirs and stays untouched. Each session's mirror replaces `skills`, so these
 * copies never outlive the bundle they came from.
 *
 * `<HOME>/.cursor/skills` is the SDK's user-scope skill root (SDK 1.0.35's skill catalog joins
 * its user home directory with `.cursor/skills`, beside `.cursor/skills-cursor` for Cursor's
 * built-ins); the host runs with HOME set to this private home.
 */
export async function addShippedSkills(
  privateHome: string,
  directories: readonly string[],
  limits: MirrorLimits = defaultLimits,
): Promise<string[]> {
  const target = join(privateHome, ".cursor", "skills");
  const added: string[] = [];
  for (const directory of directories)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = join(directory, entry.name);
      if (!(await stat(join(from, "SKILL.md")).catch(() => undefined))?.isFile()) continue;
      const to = join(target, entry.name);
      if (await lstat(to).catch(() => undefined)) continue;
      await mkdir(target, { recursive: true, mode: 0o700 });
      try {
        await copyTree(from, to, true, { entries: 0, bytes: 0 }, limits);
        added.push(entry.name);
      } catch (error) {
        await rm(to, forced);
        if (!(error instanceof OverBudget)) throw error;
      }
    }
  return added;
}

const forced = { recursive: true, force: true } as const;
const stagingPrefix = ".ace-user-config-";
function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
async function copyTree(
  from: string,
  to: string,
  directory: boolean,
  used: { entries: number; bytes: number },
  limits: MirrorLimits,
): Promise<void> {
  if (++used.entries > limits.maxEntries) throw new OverBudget();
  if (!directory) {
    const size = (await lstat(from)).size;
    used.bytes += size;
    if (used.bytes > limits.maxBytes) throw new OverBudget();
    await copyFile(from, to);
    return;
  }
  await mkdir(to, { mode: 0o700 });
  for (const child of await readdir(from, { withFileTypes: true })) {
    if (child.isSymbolicLink() || !(child.isFile() || child.isDirectory())) continue;
    await copyTree(join(from, child.name), join(to, child.name), child.isDirectory(), used, limits);
  }
}
