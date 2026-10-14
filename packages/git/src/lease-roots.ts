import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { journal, metadataDirectory, missing, text } from "./lease-journal.ts";
import type { RootKind } from "./mutation-state.ts";

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

/**
 * What a lease's recorded root is now, read from the filesystem without launching Git:
 * - `gone`: nothing is at that path any more;
 * - `unregistered`: a checkout is there, but its `.git` file points at worktree metadata that
 *   was pruned, or that now belongs to a different checkout;
 * - `linked`: a linked worktree registered with the repository that owns `directory`;
 * - `other`: anything else (a main worktree, a separate repository, a partial clone). Callers
 *   treat it as able to reach shared repository state.
 * Unreadable or malformed metadata counts as `other`, which keeps the fence.
 */
export async function rootKind(root: string, directory: string): Promise<RootKind> {
  try {
    await lstat(root);
  } catch (error) {
    if (missing(error)) return "gone";
    return "other";
  }
  try {
    const metadata = await metadataDirectory(root);
    if (!metadata) return "other";
    if ((await lstat(join(root, ".git"))).isDirectory()) return "other";
    const resolved = await canonical(metadata);
    if (!resolved) return "unregistered";
    const commondir = await text(join(resolved, "commondir"));
    // A `.git` file without `commondir` is a submodule-style checkout: its own repository.
    if (commondir === undefined) return "other";
    const back = await text(join(resolved, "gitdir"));
    if (back === undefined) return "unregistered";
    const registered = await canonical(resolve(resolved, back.replace(/\n$/, "")));
    const own = await canonical(join(root, ".git"));
    if (!registered || registered !== own) return "unregistered";
    return (await journal(root)) === directory ? "linked" : "other";
  } catch {
    return "other";
  }
}

/**
 * The repository a journal belongs to, as a person would name it: its main checkout's path, or
 * the lease's own root for a standalone journal (a clone or init before Git metadata exists).
 */
export function journalRepository(directory: string, root: string): string {
  const metadata = dirname(directory);
  if (basename(metadata) === ".ace-git-mutation-leases") return root;
  return basename(metadata) === ".git" ? dirname(metadata) : metadata;
}
