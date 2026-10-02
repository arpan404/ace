import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GitCli, textOutput } from "./cli.ts";
import { parseRemotes, parseStatus, parseWorktrees } from "./parse.ts";
import { GitError, type RepositoryInfo, type Status, type Worktree } from "./types.ts";

export class Repository {
  readonly cli: GitCli;

  constructor(cli: GitCli) {
    this.cli = cli;
  }

  async root(repo: string): Promise<string> {
    let cwd: string;
    try {
      cwd = await realpath(repo);
    } catch {
      throw new GitError("not_a_repo", `Repository path does not exist: ${repo}`);
    }
    const inside = await this.cli.call(cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowFailure: true,
    });
    if (inside.exitCode !== 0 || textOutput(inside) !== "true") {
      throw new GitError("not_a_repo", `Not a Git working tree: ${repo}`);
    }
    // rev-parse has no NUL path mode. Worktree porcelain does, including for the main tree.
    const trees = await this.worktrees(cwd);
    const roots = await Promise.all(
      trees
        .filter((tree) => !tree.bare)
        .map(async (tree) => {
          try {
            return await realpath(tree.path);
          } catch {
            return resolve(tree.path);
          }
        }),
    );
    const root = roots
      .filter((path) => within(path, cwd))
      .toSorted((a, b) => b.length - a.length)[0];
    if (!root) throw new GitError("not_a_repo", `No registered worktree contains: ${repo}`);
    return root;
  }

  async worktrees(repo: string): Promise<Worktree[]> {
    return parseWorktrees(
      (await this.cli.call(repo, ["worktree", "list", "--porcelain", "-z"])).stdout,
    );
  }

  async status(root: string): Promise<Status> {
    return (await this.state(root)).status;
  }

  async state(root: string) {
    return parseStatus(
      (
        await this.cli.call(root, [
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
          "--renames",
          "--ignore-submodules=none",
        ])
      ).stdout,
    );
  }

  async info(root: string): Promise<RepositoryInfo> {
    const { branch } = await this.state(root);
    const remotes = await this.cli.call(
      root,
      ["config", "-z", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
      { allowFailure: true },
    );
    if (remotes.exitCode !== 0 && remotes.exitCode !== 1) {
      throw new GitError("git_failed", remotes.stderr);
    }
    return { root, ...branch, remotes: parseRemotes(remotes.stdout) };
  }

  async commit(root: string, ref: string): Promise<string> {
    if (!ref || ref.includes("\0")) throw new GitError("invalid_ref", "A commit ref is required");
    const result = await this.cli.call(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) throw new GitError("invalid_ref", `Commit not found: ${ref}`);
    return textOutput(result);
  }
}

export function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
