import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ContextError, requireContext } from "./errors.ts";

/** Only filesystem absence proves deletion; an absent Git executable does not. */
export async function pathMetadata(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      throw new ContextError("not_found", "Mention path no longer exists");
    throw error;
  }
}

export interface ContainedPath {
  readonly absolute: string;
  /** Workspace-relative form Git sees; "." for the root itself. */
  readonly local: string;
  readonly info: Stats;
}

/**
 * Lstat results shared by one reconciliation, so sibling paths stat each common
 * ancestor once. A fresh scope per batch keeps every decision current.
 */
export type MetadataScope = Map<string, Promise<Stats>>;

function scoped(scope: MetadataScope, path: string): Promise<Stats> {
  let pending = scope.get(path);
  if (!pending) {
    pending = pathMetadata(path);
    scope.set(path, pending);
  }
  return pending;
}

/**
 * Proves a client or watcher path stays inside the canonical root: no absolute
 * or parent segments, no symlink on any component and no redirected realpath.
 * Ignore rules are checked separately so callers can batch them.
 */
export async function containedPath(
  root: string,
  path: string,
  scope: MetadataScope = new Map(),
): Promise<ContainedPath> {
  requireContext(
    !isAbsolute(path) && !path.includes("\0") && !path.split(/[\\/]/).includes(".."),
    "outside_workspace",
    "Mention must stay inside workspace",
  );
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  requireContext(
    !local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local),
    "outside_workspace",
    "Path escapes workspace",
  );
  let current = root,
    info: Stats | undefined;
  for (const part of local.split(sep).filter(Boolean)) {
    current = join(current, part);
    info = await scoped(scope, current);
    requireContext(!info.isSymbolicLink(), "outside_workspace", "Symlinks cannot be mentioned");
  }
  requireContext(
    (await realpath(absolute)) === absolute,
    "outside_workspace",
    "Path redirected outside workspace",
  );
  return { absolute, local: local || ".", info: info ?? (await pathMetadata(root)) };
}
