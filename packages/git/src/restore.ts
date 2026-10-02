import { assertNoGitlinks, createCheckpoint, readCheckpoint, withIndex } from "./checkpoints.ts";
import { nul } from "./parse.ts";
import { restoreWorktree, withNestedWorktrees } from "./restore-nested.ts";
import { ignoredPaths, repositoryPaths } from "./nested.ts";
import { decode, pathAncestors, pathSchema } from "./decode.ts";
import { Repository } from "./repository.ts";
import { GitError, toGitError } from "./types.ts";

export async function restoreCheckpoint(
  repository: Repository,
  root: string,
  id: string,
): Promise<{ safetyCheckpointId: string }> {
  const target = await readCheckpoint(repository, root, id);
  return withNestedWorktrees(repository, root, async (children, ownership) => {
    const safety = await createCheckpoint(
      repository,
      root,
      target.threadId,
      `Before restore of ${id}`,
      ownership,
    );
    try {
      await assertNoGitlinks(repository, root, target.tree);
      // The flattened safety tree lets Git see ignored contents below uninitialized
      // gitlinks, which the user's opaque gitlink index would hide.
      const ignored = await withIndex(repository.tempDirectory, async (env) => {
        await repository.cli.call(root, ["read-tree", safety.tree], { write: true, env });
        return ignoredPaths(repository, root, env, ownership);
      });
      const targetPaths = new Set(
        nul(
          (await repository.cli.call(root, ["ls-tree", "-r", "--name-only", "-z", target.tree]))
            .stdout,
        ).map((path) => decode(pathSchema, path, "restore path")),
      );
      for (const path of await repositoryPaths(root, targetPaths)) ignored.push(`${path}/.git`);
      const targetAncestors = new Set<string>();
      for (const path of targetPaths) {
        for (const ancestor of pathAncestors(path)) targetAncestors.add(ancestor);
      }
      // A reset can overwrite ignored files, or an ignored directory when restoring a file.
      // Refuse those collisions instead of silently losing files outside the snapshot.
      for (const path of ignored) {
        if (targetAncestors.has(path)) {
          throw new GitError(
            "restore_collision",
            `Checkpoint would overwrite ignored path: ${path}`,
          );
        }
        for (const ancestor of pathAncestors(path)) {
          if (targetPaths.has(ancestor)) {
            throw new GitError(
              "restore_collision",
              `Checkpoint would overwrite ignored path: ${path}`,
            );
          }
        }
      }
      // read-tree refuses to follow symlink directories and owns all path operations.
      await restoreWorktree(repository, root, safety.tree, target.tree, children);
      return { safetyCheckpointId: safety.id };
    } catch (error) {
      const failure = toGitError(error);
      throw new GitError(failure.code, failure.message, {
        ...failure.details,
        safetyCheckpointId: safety.id,
      });
    }
  });
}
