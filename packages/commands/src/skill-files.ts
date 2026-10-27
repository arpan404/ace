import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SkillFolder } from "./skill-model.ts";
import type { SkillDisk } from "./skill-disk.ts";
import { SkillError, sha256 } from "./skill-errors.ts";
import { skillFileLimit } from "./skill-markdown.ts";
import type { SkillRoot } from "./skill-roots.ts";

const missing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Every `<root>/<name>` that is, or links to, a directory with a SKILL.md. Bounded per root. */
export async function inspectRoots(roots: readonly SkillRoot[]): Promise<SkillFolder[]> {
  const folders: SkillFolder[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const path = resolve(root.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const rootReal = await realpath(path).catch(() => undefined);
    if (!rootReal) continue;
    const names = await readdir(path).catch(() => [] as string[]);
    for (const name of names.slice(0, 1024)) {
      if (name.startsWith(".")) continue;
      const entry = join(path, name);
      const info = await lstat(entry).catch(() => undefined);
      if (!info || !(info.isDirectory() || info.isSymbolicLink())) continue;
      const real = await realpath(entry).catch(() => undefined);
      if (!real || !(await stat(real).catch(() => undefined))?.isDirectory()) continue;
      const skill = await lstat(join(real, "SKILL.md")).catch(() => undefined);
      if (!skill?.isFile()) continue;
      folders.push({ root, name, path: entry, real, link: info.isSymbolicLink(), rootReal });
    }
  }
  return folders;
}
/** SKILL.md text and hash, never through a final symlink and never past the size limit. */
export async function readSkillFile(directory: string): Promise<{ text: string; hash: string }> {
  const handle = await open(
    join(directory, "SKILL.md"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    throw missing(error)
      ? new SkillError("not_found", "This skill no longer exists. Reload the list.")
      : new SkillError("unavailable", "Couldn't read this skill. Check its permissions.");
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > skillFileLimit)
      throw new SkillError("limit", "SKILL.md can be up to 256 KB.");
    const buffer = Buffer.alloc(skillFileLimit + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > skillFileLimit) throw new SkillError("limit", "SKILL.md can be up to 256 KB.");
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    return { text, hash: sha256(text) };
  } finally {
    await handle.close();
  }
}
const conflict = () =>
  new SkillError("conflict", "This skill changed elsewhere. Reload it before saving.");
/** SKILL.md through a pinned folder: text and hash, or `undefined` when there is none. */
export async function readPinnedSkill(
  disk: SkillDisk,
  folder: number,
): Promise<{ text: string; hash: string } | undefined> {
  const bytes = await disk.readFile(folder, "SKILL.md", skillFileLimit);
  if (!bytes) return undefined;
  const text = bytes.toString("utf8");
  return { text, hash: sha256(text) };
}
/**
 * Replace SKILL.md in a pinned folder through a temporary file and rename, checking the hash
 * before and after. Every step is relative to the folder's descriptor, never its path.
 */
export async function replacePinnedSkill(
  disk: SkillDisk,
  folder: number,
  text: string,
  expected: string | null,
  token: string,
): Promise<string> {
  if (Buffer.byteLength(text) > skillFileLimit)
    throw new SkillError("limit", "SKILL.md can be up to 256 KB. Shorten it and save again.");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(token)) throw new SkillError("invalid", "Invalid write token.");
  const current = async () => (await readPinnedSkill(disk, folder))?.hash ?? null;
  if ((await current()) !== expected) throw conflict();
  const temporary = `.SKILL.md.${token}.tmp`;
  try {
    await disk.writeNew(folder, temporary, Buffer.from(text), 0o644);
    if ((await current()) !== expected) throw conflict();
    await disk.rename(folder, temporary, folder, "SKILL.md");
  } finally {
    await disk.removeFile(folder, temporary);
  }
  return sha256(text);
}
/** The canonical folder pinned for a mutation; a moved or swapped folder fails closed. */
export function withSkillFolder<T>(
  disk: SkillDisk,
  canonical: SkillFolder,
  work: (root: number, folder: number) => Promise<T>,
): Promise<T> {
  if (canonical.real !== join(canonical.rootReal, canonical.name))
    throw new SkillError("read_only", "This skill's folder moved. Reload the list.");
  return disk.withFolder(canonical.rootReal, canonical.name, work);
}
/**
 * Make `<root>/<name>` with its SKILL.md. The root may be created; the folder must not exist.
 * Returns the folder's real path.
 */
export async function createSkill(
  disk: SkillDisk,
  root: SkillRoot,
  name: string,
  text: string,
  token: string,
): Promise<string> {
  await mkdir(root.path, { recursive: true });
  const rootReal = await realpath(root.path);
  const pinned = await disk.openPath(rootReal);
  if (pinned === undefined) throw new SkillError("unavailable", "Couldn't open the skill folder.");
  try {
    if (!(await disk.makeDirectory(pinned, name))) {
      const existing = await disk.openDirectory(pinned, name);
      if (existing !== undefined) {
        await disk.closeDirectory(existing);
        throw new SkillError("exists", `A skill called ${name} already exists there.`);
      }
      throw new SkillError("unavailable", "Couldn't make the skill folder. Check its permissions.");
    }
    try {
      await disk.withFolder(rootReal, name, (_root, folder) =>
        replacePinnedSkill(disk, folder, text, null, token),
      );
    } catch (error) {
      await disk.remove(pinned, name);
      throw error;
    }
  } finally {
    await disk.closeDirectory(pinned);
  }
  return join(rootReal, name);
}
/** A link root pinned by its resolved path for `work`. */
async function withLinkRoot<T>(
  disk: SkillDisk,
  rootReal: string,
  work: (root: number) => Promise<T>,
): Promise<T> {
  const root = await disk.openPath(rootReal);
  if (root === undefined)
    throw new SkillError("conflict", "A skill folder changed elsewhere. Reload the list.");
  try {
    return await work(root);
  } finally {
    await disk.closeDirectory(root);
  }
}
/**
 * A relative link `<root>/<name> -> canonical`, as the `skills` CLI lays them out. Made with
 * symlinkat in the pinned root, so a root swapped for a symlink can't place it elsewhere.
 */
export async function linkSkill(
  disk: SkillDisk,
  root: SkillRoot,
  name: string,
  canonical: SkillFolder,
): Promise<void> {
  await mkdir(root.path, { recursive: true });
  const rootReal = await realpath(root.path);
  await withLinkRoot(disk, rootReal, async (pinned) => {
    // Relative to the folder the link really sits in, which is where the system resolves it.
    const target = relative(rootReal, canonical.real);
    if (!(await disk.symlink(pinned, target, name)))
      throw new SkillError("exists", `Another folder called ${name} is already in ${root.path}.`);
    if ((await realpath(join(rootReal, name)).catch(() => undefined)) !== canonical.real) {
      // Windows reads link text by path, which a moved root no longer has; the junction just made
      // through the handle is taken back through the handle while it is still a link.
      if (process.platform === "win32" && (await disk.windowsLink(pinned, name)))
        await disk.removeFile(pinned, name);
      if ((await disk.readLink(pinned, name)) === target) await disk.removeFile(pinned, name);
      throw new SkillError("unavailable", "The new link didn't reach this skill's folder.");
    }
  });
}
/**
 * Remove a link only if it is still a link to this skill. The root is pinned at the resolved path
 * the listing saw, and the link read and removed through it (readlinkat, unlinkat), so a root
 * swapped for a symlink before or during the removal can't redirect it.
 */
export async function unlinkSkill(disk: SkillDisk, link: SkillFolder): Promise<void> {
  const rootReal = link.rootReal;
  await withLinkRoot(disk, rootReal, async (pinned) => {
    const target = await disk.readLink(pinned, link.name);
    if (target === undefined) {
      if (await disk.exists(pinned, link.name))
        throw new SkillError("conflict", "A skill link changed elsewhere. Reload the list.");
      return;
    }
    if ((await realpath(resolve(rootReal, target)).catch(() => "")) !== link.real)
      throw new SkillError("conflict", "A skill link changed elsewhere. Reload the list.");
    await disk.removeFile(pinned, link.name);
  });
}
