import { devNull } from "node:os";
import { patchOutput } from "./cli.ts";
import { readCheckpoint, snapshot } from "./checkpoints.ts";
import { binaryNotices, classifyBinaries, textTrees } from "./diff-binary.ts";
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
  if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes < 0)
    throw new GitError("invalid_argument", "maxPatchBytes must be a non-negative integer");
  const live =
    from.kind === "working-tree" || to.kind === "working-tree"
      ? await snapshot(repository, root)
      : undefined;
  const resolveSide = async (side: DiffSide): Promise<string> => {
    if (side.kind === "working-tree") {
      if (!live) throw new GitError("git_failed", "Missing live tree");
      return live;
    }
    if (side.kind === "checkpoint") return (await readCheckpoint(repository, root, side.id)).sha;
    return repository.commit(root, side.ref);
  };
  let a = await resolveSide(from);
  let b = await resolveSide(to);
  const args = [
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    `-O${devNull}`,
    "--no-relative",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--ignore-submodules=none",
    "--submodule=short",
    "--diff-algorithm=myers",
    "--indent-heuristic",
    "--find-renames=50%",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--line-prefix=",
  ];
  const metadata = await repository.cli.call(root, [
    ...args,
    "--raw",
    "--no-abbrev",
    "--numstat",
    "-z",
    a,
    b,
    "--",
  ]);
  const files = parseDiff(metadata.stdout);
  await classifyBinaries(repository, root, files);
  const notices = Buffer.from(binaryNotices(files));
  const prefix = notices.subarray(0, maxPatchBytes);
  let truncated = notices.length > maxPatchBytes;
  let bytes = prefix;
  if (!truncated && files.some((file) => !file.entry.binary)) {
    // Only changed text entries enter the patch indexes. Both sides of every
    // binary rename are absent, without materializing the repository index.
    if (files.some((file) => file.entry.binary)) [a, b] = await textTrees(repository, root, files);
    const patch = await repository.cli.call(
      root,
      [...args, "--patch", "--unified=3", "--inter-hunk-context=0", "-z", a, b, "--"],
      {
        captureBytes: maxPatchBytes - prefix.length,
      },
    );
    bytes = Buffer.concat([prefix, patch.stdout]);
    truncated = patch.truncated;
  }
  return {
    entries: files.map((file) => file.entry),
    patch: patchOutput({ stdout: bytes, truncated, stderr: "", exitCode: 0 }),
    truncated,
  };
}
