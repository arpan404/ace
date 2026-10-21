import { copyFile, lstat, mkdir, realpath, stat, symlink as fsSymlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export type ArchiveLink = {
  linkPath: string;
  target: string;
};

export type SymlinkFn = (target: string, path: string, type?: "junction") => Promise<void>;

function inside(rootReal: string, path: string): boolean {
  return path === rootReal || path.startsWith(rootReal + sep);
}

function badTarget(target: string): boolean {
  return (
    !target ||
    target.includes("\0") ||
    target.startsWith("\\\\") ||
    target.startsWith("//") ||
    /^[a-zA-Z]:/.test(target)
  );
}

async function anchorReal(dir: string): Promise<string | "deferred"> {
  let ancestor = dir;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor)
        throw new Error("Archive link escapes destination", { cause: error });
      ancestor = parent;
    }
  }
  try {
    return await realpath(ancestor);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "deferred";
    throw error;
  }
}

async function attempt(
  rootReal: string,
  link: ArchiveLink,
  symlink: SymlinkFn,
): Promise<"created" | "deferred" | "skipped"> {
  const target = link.target;
  if (badTarget(target)) throw new Error("Archive link escapes destination");
  const dir = dirname(link.linkPath);
  const anchor = await anchorReal(dir);
  if (anchor === "deferred") return "deferred";
  if (!inside(rootReal, anchor)) throw new Error("Archive link escapes destination");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (target.startsWith("/")) {
    // Absolute POSIX targets (venv interpreters) are created verbatim: nothing is
    // written through links and the entrypoint realpath check refuses escapes.
    try {
      await symlink(target, link.linkPath);
      return "created";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
      return "skipped";
    }
  }
  let parentReal: string;
  try {
    parentReal = await realpath(dir);
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
    if (!progressed) break;
    remaining = deferred;
  }
  for (const link of links) {
    if (link.target.startsWith("/")) continue;
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
