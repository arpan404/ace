import { z } from "zod";
import { textOutput } from "./cli.ts";
import { decode, hash } from "./decode.ts";
import { parseIndex, type IndexEntry } from "./parse-index.ts";
import type { Repository } from "./repository.ts";
import { withIndex } from "./temporary-index.ts";
import { GitError } from "./types.ts";

// Snapshot capture and restore discovery must see the same HEAD/index union,
// including HEAD paths staged for deletion and now hidden by ignore rules.
export async function withSnapshotIndex<T>(
  repository: Repository,
  root: string,
  operation: (env: Record<string, string>, seeded: IndexEntry[]) => Promise<T>,
): Promise<T> {
  const { cli } = repository;
  const sparse = await cli.call(root, ["config", "--type=bool", "--get", "core.sparseCheckout"], {
    allowFailure: true,
  });
  if (sparse.exitCode !== 0 && sparse.exitCode !== 1)
    throw new GitError("git_failed", sparse.stderr);
  if (
    sparse.exitCode === 0 &&
    decode(z.enum(["true", "false"]), textOutput(sparse), "sparse checkout config") === "true"
  )
    throw new GitError(
      "unsupported_repository",
      "Full working-tree snapshots do not support sparse checkout",
    );
  return withIndex(repository.tempDirectory, async (env) => {
    const head = await cli.call(root, ["rev-parse", "--verify", "HEAD^{tree}"], {
      allowFailure: true,
    });
    await cli.call(
      root,
      ["read-tree", ...(head.exitCode === 0 ? [hash(textOutput(head))] : ["--empty"])],
      { write: true, env },
    );
    const tracked = parseIndex((await cli.call(root, ["ls-files", "--stage", "-z"])).stdout);
    const seed = tracked.map((entry) => `${entry.mode} ${entry.sha} 0\t${entry.path}\0`).join("");
    await cli.call(root, ["update-index", "-z", "--index-info"], { write: true, env, input: seed });
    const seeded = parseIndex(
      (await cli.call(root, ["ls-files", "--stage", "-z"], { env })).stdout,
    );
    return operation(env, seeded);
  });
}
