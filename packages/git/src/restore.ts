import { assertNoGitlinks, createCheckpoint, readCheckpoint, withIndex } from "./checkpoints.ts";
import { nul } from "./parse.ts";
import { decode, pathSchema } from "./decode.ts";
import { Repository } from "./repository.ts";
import { GitError, toGitError } from "./types.ts";

export async function restoreCheckpoint(
  repository: Repository,
  root: string,
  id: string,
): Promise<{ safetyCheckpointId: string }> {
  const target = await readCheckpoint(repository, root, id);
  const safety = await createCheckpoint(
    repository,
    root,
    target.threadId,
    `Before restore of ${id}`,
  );
  try {
    await assertNoGitlinks(repository, root, target.tree);
    const ignored = nul(
      (
        await repository.cli.call(root, [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
        ])
      ).stdout,
    ).map((path) => decode(pathSchema, path, "ignored path"));
    const targetPaths = new Set(
      nul(
        (await repository.cli.call(root, ["ls-tree", "-r", "--name-only", "-z", target.tree]))
          .stdout,
      ).map((path) => decode(pathSchema, path, "restore path")),
    );
    const targetAncestors = new Set<string>();
    for (const path of targetPaths) {
      const parts = path.split("/");
      for (let n = 1; n <= parts.length; n++) targetAncestors.add(parts.slice(0, n).join("/"));
    }
    // A reset can overwrite ignored files, or an ignored directory when restoring a file.
    // Refuse those collisions instead of silently losing files outside the snapshot.
    for (const path of ignored) {
      if (targetAncestors.has(path)) {
        throw new GitError("restore_collision", `Checkpoint would overwrite ignored path: ${path}`);
      }
      const parts = path.split("/");
      for (let n = 1; n <= parts.length; n++) {
        if (targetPaths.has(parts.slice(0, n).join("/"))) {
          throw new GitError(
            "restore_collision",
            `Checkpoint would overwrite ignored path: ${path}`,
          );
        }
      }
    }
    // read-tree refuses to follow symlink directories and owns all path operations.
    await withIndex(repository.tempDirectory, async (env) => {
      await repository.cli.call(root, ["read-tree", safety.tree], { write: true, env });
      await repository.cli.call(
        root,
        ["read-tree", "--reset", "-u", "--no-sparse-checkout", target.tree],
        { write: true, env },
      );
    });
    return { safetyCheckpointId: safety.id };
  } catch (error) {
    const failure = toGitError(error);
    throw new GitError(failure.code, failure.message, {
      ...failure.details,
      safetyCheckpointId: safety.id,
    });
  }
}
