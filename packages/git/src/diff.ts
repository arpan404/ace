import { devNull } from "node:os";
import { patchOutput } from "./cli.ts";
import { readCheckpoint, snapshot } from "./checkpoints.ts";
import { binaryNotices, classifyBinaries, textTree } from "./diff-binary.ts";
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
  const excluded = new Set<string>();
  for (const { entry } of files)
    if (entry.binary) {
      excluded.add(entry.path);
      if (entry.oldPath) excluded.add(entry.oldPath);
    }
  // Removing exact index paths handles file/directory replacements safely too.
  // Binary objects are absent from both patch trees, even when attributes force text.
  if (excluded.size) {
    a = await textTree(repository, root, a, [...excluded]);
    b = await textTree(repository, root, b, [...excluded]);
  }
  const notices = Buffer.from(binaryNotices(files));
  const prefix = notices.subarray(0, maxPatchBytes);
  let truncated = notices.length > maxPatchBytes;
  let bytes = prefix;
  if (!truncated) {
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
