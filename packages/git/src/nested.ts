import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { decode, nul, pathSchema } from "./decode.ts";
import { parseIndex, parseTree, type IndexEntry } from "./parse-index.ts";
import type { Repository } from "./repository.ts";
import { textOutput } from "./cli.ts";
import { transferTree } from "./object-transfer.ts";
import { serial } from "./lock.ts";
import { GitError } from "./types.ts";

export async function nestedPaths(
  repository: Repository,
  root: string,
  tracked: IndexEntry[],
): Promise<string[]> {
  const paths = new Set(tracked.filter((e) => e.mode === "160000").map((e) => e.path));
  const untracked = nul(
    (await repository.cli.call(root, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout,
  );
  for (const record of untracked) {
    const path = decode(
      pathSchema,
      record.endsWith("/") ? record.slice(0, -1) : record,
      "untracked path",
    );
    if (record.endsWith("/")) paths.add(path);
  }
  const nested: string[] = [];
  for (const path of paths) {
    try {
      await stat(join(root, path, ".git"));
      nested.push(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return nested.toSorted();
}

export async function flattenNested(
  repository: Repository,
  root: string,
  paths: string[],
  env: Record<string, string>,
  snapshot: (repository: Repository, root: string) => Promise<string>,
): Promise<void> {
  for (const path of paths) {
    const nested = await realpath(join(root, path));
    if (textOutput(await repository.cli.call(nested, ["rev-parse", "--show-prefix"])) !== "")
      throw new GitError("not_a_repo", "Nested path is not a repository root");
    if (relative(root, nested).split(sep).join("/") !== path)
      throw new GitError(
        "unsupported_repository",
        "Nested repository must have its own working root",
      );
    await serial(nested, async () => {
      const tree = await snapshot(repository, nested);
      await transferTree(repository, nested, root, tree);
      const entries = parseTree(
        (await repository.cli.call(root, ["ls-tree", "-r", "-z", tree])).stdout,
      );
      const input =
        `0 ${"0".repeat(tree.length)}\t${path}\0` +
        entries.map((e) => `${e.mode} ${e.sha} 0\t${path}/${e.path}\0`).join("");
      await repository.cli.call(root, ["update-index", "-z", "--index-info"], {
        write: true,
        env,
        input,
      });
    });
  }
}

export async function ignoredPaths(
  repository: Repository,
  root: string,
  env: Record<string, string> = {},
): Promise<string[]> {
  const ignored = nul(
    (
      await repository.cli.call(
        root,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        { env },
      )
    ).stdout,
  ).map((p) => decode(pathSchema, p, "ignored path"));
  const tracked = parseIndex(
    (await repository.cli.call(root, ["ls-files", "--stage", "-z"])).stdout,
  );
  for (const path of await nestedPaths(repository, root, tracked))
    for (const child of await ignoredPaths(repository, join(root, path)))
      ignored.push(`${path}/${child}`);
  return ignored;
}
