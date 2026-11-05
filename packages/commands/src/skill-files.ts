import { dirname, join, relative, resolve } from "node:path";
import { writeOutcomeUnknown } from "./posix-ops.ts";
import { removeCommandEntryLater } from "./posix.ts";
import {
  listCommandPath,
  lstatCommandPath,
  makeCommandPath,
  readCommandPath,
  realCommandPath,
  statCommandPath,
} from "./posix-calls.ts";
import type { SkillFolder } from "./skill-model.ts";
import type { SkillDisk } from "./skill-disk.ts";
import { SkillError, sha256 } from "./skill-errors.ts";
import { skillFileLimit } from "./skill-markdown.ts";
import type { SkillRoot } from "./skill-roots.ts";

const missing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

// Path calls run on the skill root's own thread (posix-calls), never on the shared file pool.
/** Every `<root>/<name>` that is, or links to, a directory with a SKILL.md. Bounded per root. */
export async function inspectRoots(roots: readonly SkillRoot[]): Promise<SkillFolder[]> {
  const folders: SkillFolder[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const path = resolve(root.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const rootReal = await realCommandPath(path, path).catch(() => undefined);
    if (!rootReal) continue;
    const names = await listCommandPath(path, path, 1024).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const entry = join(path, name);
      const info = await lstatCommandPath(path, entry).catch(() => undefined);
      if (!info || !(info.isDirectory() || info.isSymbolicLink())) continue;
      const real = await realCommandPath(path, entry).catch(() => undefined);
      if (!real || !(await statCommandPath(path, real).catch(() => undefined))?.isDirectory())
        continue;
      const skill = await lstatCommandPath(path, join(real, "SKILL.md")).catch(() => undefined);
      if (!skill?.isFile()) continue;
      folders.push({ root, name, path: entry, real, link: info.isSymbolicLink(), rootReal });
    }
  }
  return folders;
}
/** SKILL.md text and hash, never through a final symlink and never past the size limit. */
export async function readSkillFile(directory: string): Promise<{ text: string; hash: string }> {
  const bytes = await readCommandPath(
    dirname(directory),
    join(directory, "SKILL.md"),
    skillFileLimit,
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EFBIG")
      throw new SkillError("limit", "SKILL.md can be up to 256 KB.");
    throw missing(error)
      ? new SkillError("not_found", "This skill no longer exists. Reload the list.")
      : new SkillError("unavailable", "Couldn't read this skill. Check its permissions.");
  });
  const text = bytes.toString("utf8");
  return { text, hash: sha256(text) };
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
  /** Where the folder is, to clean up by path if this folder's thread is abandoned. */
  location: { rootReal: string; name: string },
): Promise<string> {
  if (Buffer.byteLength(text) > skillFileLimit)
    throw new SkillError("limit", "SKILL.md can be up to 256 KB. Shorten it and save again.");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(token)) throw new SkillError("invalid", "Invalid write token.");
  const current = async () => (await readPinnedSkill(disk, folder))?.hash ?? null;
  if ((await current()) !== expected) throw conflict();
  const temporary = `.SKILL.md.${token}.tmp`;
  let failure: unknown;
  try {
    await disk.writeNew(folder, temporary, Buffer.from(text), 0o644);
    if ((await current()) !== expected) throw conflict();
    await disk.rename(folder, temporary, folder, "SKILL.md");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // After a change that timed out, the temporary file goes once the folder has settled (the
    // rename may still land); a failed cleanup never replaces the save's own error.
    if (writeOutcomeUnknown(failure))
      removeCommandEntryLater(location.rootReal, join(location.rootReal, location.name), temporary);
    else
      await disk.removeFile(folder, temporary).catch((error: unknown) => {
        if (failure === undefined) throw error;
      });
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
  await makeCommandPath(root.path, root.path);
  const rootReal = await realCommandPath(root.path, root.path);
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
        replacePinnedSkill(disk, folder, text, null, token, { rootReal, name }),
      );
    } catch (error) {
      // A step that timed out may still land: undo once the folder has settled, never racing
      // it, and keep reporting that the outcome is unknown.
      if (writeOutcomeUnknown(error)) disk.removeWhenSettled(rootReal, name);
      else await disk.remove(pinned, name).catch(() => {});
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
  await makeCommandPath(root.path, root.path);
  const rootReal = await realCommandPath(root.path, root.path);
  await withLinkRoot(disk, rootReal, async (pinned) => {
    // Relative to the folder the link really sits in, which is where the system resolves it.
    const target = relative(rootReal, canonical.real);
    if (!(await disk.symlink(pinned, target, name)))
      throw new SkillError("exists", `Another folder called ${name} is already in ${root.path}.`);
    if (
      (await realCommandPath(rootReal, join(rootReal, name)).catch(() => undefined)) !==
      canonical.real
    ) {
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
    if ((await realCommandPath(rootReal, resolve(rootReal, target)).catch(() => "")) !== link.real)
      throw new SkillError("conflict", "A skill link changed elsewhere. Reload the list.");
    await disk.removeFile(pinned, link.name);
  });
}
