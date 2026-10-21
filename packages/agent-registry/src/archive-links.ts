import { copyFile, mkdir, realpath, stat, symlink as fsSymlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export type ArchiveLink = {
  linkPath: string;
  target: string;
  normalizeBackslash: boolean;
};

export type SymlinkFn = (target: string, path: string, type?: "junction") => Promise<void>;

function normalizedTarget(link: ArchiveLink): string {
  return link.normalizeBackslash ? link.target.replaceAll("\\", "/") : link.target;
}

function inside(rootReal: string, path: string): boolean {
  return path === rootReal || path.startsWith(rootReal + sep);
}

async function attempt(
  rootReal: string,
  link: ArchiveLink,
  symlink: SymlinkFn,
): Promise<"created" | "deferred"> {
  const target = normalizedTarget(link);
  if (!target || target.includes("\0") || isAbsolute(target) || /^[a-zA-Z]:/.test(target))
    throw new Error("Archive link escapes destination");
  await mkdir(dirname(link.linkPath), { recursive: true, mode: 0o700 });
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(link.linkPath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "deferred";
    throw error;
  }
  const resolved = resolve(parentReal, target);
  if (!inside(rootReal, resolved)) throw new Error("Archive link escapes destination");
  try {
    await symlink(target, link.linkPath);
    return "created";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    let targetStat;
    try {
      targetStat = await stat(resolved);
    } catch (statError) {
      if (statError instanceof Error && "code" in statError && statError.code === "ENOENT")
        return "deferred";
      throw statError;
    }
    if (targetStat.isDirectory()) await symlink(resolved, link.linkPath, "junction");
    else await copyFile(resolved, link.linkPath);
    return "created";
  }
}

export async function createArchiveLinks(
  root: string,
  links: readonly ArchiveLink[],
  symlink: SymlinkFn = fsSymlink,
): Promise<void> {
  if (links.length === 0) return;
  const rootReal = await realpath(root);
  let remaining = [...links];
  while (remaining.length > 0) {
    const deferred: ArchiveLink[] = [];
    let progressed = false;
    for (const link of remaining) {
      const outcome = await attempt(rootReal, link, symlink);
      if (outcome === "deferred") deferred.push(link);
      else progressed = true;
    }
    if (deferred.length === 0) break;
    if (!progressed) throw new Error("Archive link target unavailable");
    remaining = deferred;
  }
  for (const link of links) {
    let resolved: string;
    try {
      resolved = await realpath(link.linkPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!inside(rootReal, resolved)) throw new Error("Archive link escapes destination");
  }
}
