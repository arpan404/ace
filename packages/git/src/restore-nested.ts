import { nestedPaths, nestedRoot, type NestedWorktree, type SnapshotOwnership } from "./nested.ts";
import { parseTree } from "./parse-index.ts";
import { transferTree } from "./object-transfer.ts";
import { removeIndexSubtrees, withIndex } from "./temporary-index.ts";
import { hash, malformed } from "./decode.ts";
import { textOutput } from "./cli.ts";
import type { Repository } from "./repository.ts";
import { withSnapshotIndex } from "./snapshot-index.ts";

// The caller holds the outer root. Acquire descendants in hierarchy order and
// retain every lock through safety capture and all filesystem changes.
export async function withNestedWorktrees<T>(
  repository: Repository,
  root: string,
  operation: (children: NestedWorktree[], ownership: SnapshotOwnership) => Promise<T>,
): Promise<T> {
  const ownership = new Map<string, readonly NestedWorktree[]>();
  const discover = async (
    parent: string,
    complete: (children: NestedWorktree[]) => Promise<T>,
  ): Promise<T> => {
    const paths = await withSnapshotIndex(repository, parent, (env, tracked) =>
      nestedPaths(repository, parent, tracked, env),
    );
    const children: NestedWorktree[] = [];
    ownership.set(parent, children);
    const acquire = async (index: number): Promise<T> => {
      const path = paths[index];
      if (path === undefined) return complete(children);
      const child = await nestedRoot(repository, parent, path);
      return repository.serial(child, async () => {
        return discover(child, async (descendants) => {
          children.push({ path, root: child, children: descendants });
          return acquire(index + 1);
        });
      });
    };
    return acquire(0);
  };
  return discover(root, (children) => operation(children, ownership));
}

// Materialize only this repository's files. Children own their filters and
// deletions, including when a target has no subtree for an existing child.
export async function restoreWorktree(
  repository: Repository,
  root: string,
  before: string,
  target: string,
  children: NestedWorktree[],
): Promise<void> {
  const ownedTree = async (tree: string, env: Record<string, string>) => {
    if (!children.length) return tree;
    await repository.cli.call(root, ["read-tree", tree], { write: true, env });
    await removeIndexSubtrees(
      repository,
      root,
      children.map((child) => child.path),
      env,
    );
    return hash(textOutput(await repository.cli.call(root, ["write-tree"], { write: true, env })));
  };
  await withIndex(repository.tempDirectory, async (env) => {
    const from = await ownedTree(before, env);
    const to = await ownedTree(target, env);
    await repository.cli.call(root, ["read-tree", from], { write: true, env });
    await repository.cli.call(root, ["read-tree", "--reset", "-u", "--no-sparse-checkout", to], {
      write: true,
      env,
    });
  });
  for (const child of children) {
    const from = await subtree(repository, root, before, child.path);
    const to = await subtree(repository, root, target, child.path);
    await transferTree(repository, root, child.root, from);
    if (to !== from) await transferTree(repository, root, child.root, to);
    await restoreWorktree(repository, child.root, from, to, child.children);
  }
}

async function subtree(
  repository: Repository,
  root: string,
  tree: string,
  path: string,
): Promise<string> {
  const entries = parseTree(
    (await repository.cli.call(root, ["ls-tree", "-z", tree, "--", `:(literal)${path}`])).stdout,
  );
  if (!entries.length) {
    return withIndex(repository.tempDirectory, async (env) => {
      await repository.cli.call(root, ["read-tree", "--empty"], { write: true, env });
      return hash(
        textOutput(await repository.cli.call(root, ["write-tree"], { write: true, env })),
      );
    });
  }
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry.path !== path || entry.type !== "tree")
    throw malformed("nested restore subtree");
  return entry.sha;
}
