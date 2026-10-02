import { patchOutput } from "./cli.ts";
import { readCheckpoint, snapshot } from "./checkpoints.ts";
import { parseDiff } from "./parse.ts";
import { Repository } from "./repository.ts";
import { GitError, type DiffResult, type DiffSide } from "./types.ts";

export async function diff(
  repository: Repository,
  root: string,
  from: DiffSide,
  to: DiffSide,
  maxPatchBytes: number,
): Promise<DiffResult> {
  if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes < 0) {
    throw new GitError("invalid_argument", "maxPatchBytes must be a non-negative integer");
  }
  // Both live sides refer to the same snapshot, rather than two moving observations.
  const live =
    from.kind === "working-tree" || to.kind === "working-tree"
      ? await snapshot(repository, root)
      : undefined;
  const resolveSide = async (side: DiffSide): Promise<string> => {
    if (side.kind === "working-tree") return live!;
    if (side.kind === "checkpoint") return (await readCheckpoint(repository, root, side.id)).sha;
    return repository.commit(root, side.ref);
  };
  const a = await resolveSide(from);
  const b = await resolveSide(to);
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames=50%",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  const metadata = await repository.cli.call(root, [
    ...args,
    "--raw",
    "--numstat",
    "-z",
    a,
    b,
    "--",
  ]);
  const patch = await repository.cli.call(root, [...args, "--patch", "-z", a, b, "--"], {
    captureBytes: maxPatchBytes,
  });
  return {
    entries: parseDiff(metadata.stdout),
    patch: patchOutput(patch),
    truncated: patch.truncated,
  };
}
