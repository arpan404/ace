/**
 * What an archive transfer (ADR 0101 method 3) leaves behind. Two cases:
 *
 * - A folder inside a Git work tree (a subfolder of a repository, or a repository with nothing
 *   committed) travels like the Git methods would carry it: its `.git` and nested repositories
 *   stay, and files Git ignores go only when ignored files are allowed, without the dependency
 *   and cache folders `rebuiltFolder` names.
 * - A plain folder has no ignore rules: dependency and cache folders stay wherever they sit, and
 *   `.env` files (not `.env.example` and the like) go only when ignored files are allowed.
 *
 * Everything else travels as it is on disk now, uncommitted or not: `includeChanges` has no
 * meaning for an archive.
 */
import type { FolderPrune } from "@ace/files";
import { rebuiltFolder } from "./ignored-files.ts";

type Member = Parameters<FolderPrune>[0];

/** `.env` and `.env.local`-style files; templates meant to be committed are not secrets. */
function secretFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !/\.(example|sample|template|dist|defaults)$/i.test(name);
}

/**
 * Git's ignored paths (work-tree relative, as `ignoredPaths` lists them, a folder ending in `/`)
 * as paths relative to the project at `path` in that work tree ("" at its top). Undefined when
 * Git ignores the project folder itself: the person chose it, so it goes as a plain folder.
 */
export function ignoredInProject(
  ignored: readonly string[],
  path: string,
): ReadonlySet<string> | undefined {
  if (!path) return new Set(ignored);
  const prefix = `${path}/`;
  const inside = new Set<string>();
  for (const entry of ignored) {
    if (entry.endsWith("/") && prefix.startsWith(entry)) return undefined;
    if (entry.startsWith(prefix) && entry.length > prefix.length)
      inside.add(entry.slice(prefix.length));
  }
  return inside;
}

/** Whether Git ignores `member`, itself or through a folder above it. */
function ignoredBy(ignored: ReadonlySet<string>, member: Member): boolean {
  if (ignored.has(member.kind === "directory" ? `${member.path}/` : member.path)) return true;
  const parts = member.path.split("/");
  for (let end = 1; end < parts.length; end++)
    if (ignored.has(`${parts.slice(0, end).join("/")}/`)) return true;
  return false;
}

/**
 * The prune rule for an archive. `checkout` is set for a folder inside a work tree, with
 * `ignoredInProject`'s answer; leave it out for a plain folder.
 */
export function archivePrune(input: {
  includeIgnored: boolean;
  checkout?: { ignored: ReadonlySet<string> } | undefined;
}): FolderPrune {
  const { includeIgnored, checkout } = input;
  if (!checkout)
    return (member) =>
      member.kind === "directory"
        ? rebuiltFolder(member.path)
        : !includeIgnored && secretFile(member.path);
  return (member) => {
    if (member.path === ".git") return true;
    if (member.kind === "directory" && member.names?.includes(".git")) return true;
    if (!ignoredBy(checkout.ignored, member)) return false;
    return !includeIgnored || (member.kind === "directory" && rebuiltFolder(member.path));
  };
}
