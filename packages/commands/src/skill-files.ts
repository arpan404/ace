import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { inside, type SkillFolder } from "./skill-model.ts";
import { skillFileLimit } from "./skill-markdown.ts";
import type { SkillRoot } from "./skill-roots.ts";

export type SkillErrorCode =
  | "not_found"
  | "conflict"
  | "exists"
  | "invalid"
  | "limit"
  | "read_only"
  | "update_failed"
  | "unavailable";
export class SkillError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
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
/** The canonical folder, checked again right before a write: real, inside its root, unchanged. */
export async function writableDirectory(folder: SkillFolder): Promise<string> {
  const info = await lstat(folder.path).catch(() => undefined);
  const rootReal = await realpath(folder.root.path).catch(() => undefined);
  const real = await realpath(folder.path).catch(() => undefined);
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    !rootReal ||
    rootReal !== folder.rootReal ||
    real !== folder.real ||
    !inside(rootReal, real)
  )
    throw new SkillError("read_only", "This skill's folder moved. Reload the list.");
  return real;
}
/** Replace SKILL.md through a temporary file and rename, checking the hash before and after. */
export async function replaceSkillFile(
  directory: string,
  text: string,
  expected: string | null,
  token: string,
): Promise<string> {
  if (Buffer.byteLength(text) > skillFileLimit)
    throw new SkillError("limit", "SKILL.md can be up to 256 KB. Shorten it and save again.");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(token)) throw new SkillError("invalid", "Invalid write token.");
  const current = async () => {
    try {
      return (await readSkillFile(directory)).hash;
    } catch (error) {
      if (error instanceof SkillError && error.code === "not_found") return null;
      throw error;
    }
  };
  const conflict = () =>
    new SkillError("conflict", "This skill changed elsewhere. Reload it before saving.");
  if ((await current()) !== expected) throw conflict();
  const temporary = join(directory, `.SKILL.md.${token}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await current()) !== expected) throw conflict();
    await rename(temporary, join(directory, "SKILL.md"));
  } finally {
    await rm(temporary, { force: true });
  }
  return sha256(text);
}
/** Make `<root>/<name>` for a new skill. The root may be created; the folder must not exist. */
export async function createSkillDirectory(root: SkillRoot, name: string): Promise<string> {
  await mkdir(root.path, { recursive: true });
  const rootReal = await realpath(root.path);
  const directory = join(rootReal, name);
  try {
    await mkdir(directory, { mode: 0o755 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new SkillError("exists", `A skill called ${name} already exists there.`);
    throw error;
  }
  return directory;
}
/** A relative link `<root>/<name> -> canonical`, as the `skills` CLI lays them out. */
export async function linkSkill(root: SkillRoot, name: string, canonical: SkillFolder) {
  await mkdir(root.path, { recursive: true });
  const at = join(root.path, name);
  try {
    await symlink(relative(dirname(at), canonical.path), at, "dir");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new SkillError("exists", `Another folder called ${name} is already in ${root.path}.`);
    throw error;
  }
  if ((await realpath(at).catch(() => undefined)) !== canonical.real) {
    await unlink(at).catch(() => {});
    throw new SkillError("unavailable", "The new link didn't reach this skill's folder.");
  }
}
/** Remove a link only if it is still a link to this skill. */
export async function unlinkSkill(link: SkillFolder): Promise<void> {
  const info = await lstat(link.path).catch(() => undefined);
  if (!info) return;
  if (!info.isSymbolicLink() || (await realpath(link.path).catch(() => "")) !== link.real)
    throw new SkillError("conflict", "A skill link changed elsewhere. Reload the list.");
  await unlink(link.path);
}
export async function removeSkillDirectory(canonical: SkillFolder): Promise<void> {
  const real = await writableDirectory(canonical);
  await rm(real, { recursive: true });
}
