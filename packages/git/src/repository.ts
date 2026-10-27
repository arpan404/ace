import { within } from "./repository-paths.ts";
export { within } from "./repository-paths.ts";
import { serial } from "./lock.ts";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { resolve } from "node:path";
import { GitCli, textOutput } from "./cli.ts";
import { decode, hash } from "./decode.ts";
import { CheckpointNumbers } from "./checkpoint-numbers.ts";
import { parseRemotes, parseStatus, parseWorktrees } from "./parse.ts";
import { nativeWorktreePaths } from "./parse.ts";
import { GitError, type RepositoryInfo, type Status, type Worktree } from "./types.ts";

export class Repository {
  readonly cli: GitCli;
  readonly numbers: CheckpointNumbers;
  readonly now: () => Date | Promise<Date>;
  readonly tempDirectory: string;

  constructor(
    cli: GitCli,
    now: () => Date | Promise<Date>,
    tempDirectory: string,
    counterCapacity?: number,
  ) {
    this.cli = cli;
    this.numbers = new CheckpointNumbers(cli, counterCapacity);
    this.now = now;
    this.tempDirectory = tempDirectory;
  }

  async serial<T>(root: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      throw new GitError("not_a_repo", `Repository path does not exist: ${root}`);
    }
    return serial(canonical, operation, this.cli.leaseId, this.cli.leaseProbe, signal);
  }

  async root(repo: string, signal?: AbortSignal): Promise<string> {
    let cwd: string;
    try {
      cwd = await realpath(repo);
    } catch {
      throw new GitError("not_a_repo", `Repository path does not exist: ${repo}`);
    }
    // A checkout root stays its own root until its `.git`, Git directory or config changes.
    // Only that answer is kept: a deeper path's root also depends on the worktree registry.
    return this.cli.configFact(
      cwd,
      "root",
      () => this.discoverRoot(repo, cwd, signal),
      (root) => root === cwd,
    );
  }

  private async discoverRoot(repo: string, cwd: string, signal?: AbortSignal): Promise<string> {
    const inside = await this.cli.call(cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowFailure: true,
      ...(signal ? { signal } : {}),
    });
    if (
      inside.exitCode !== 0 ||
      decode(z.enum(["true", "false"]), textOutput(inside), "worktree flag") !== "true"
    ) {
      throw new GitError("not_a_repo", `Not a Git working tree: ${repo}`);
    }
    // rev-parse has no NUL path mode. Worktree porcelain does, including for the main tree.
    const trees = await this.worktrees(cwd, signal);
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

  async worktrees(repo: string, signal?: AbortSignal): Promise<Worktree[]> {
    if (this.cli.platform === "win32")
      return nativeWorktreePaths(
        parseWorktrees(
          (await this.cli.call(repo, ["worktree", "list", "--porcelain", "-z"], { signal })).stdout,
        ),
      );
    return parseWorktrees(
      (
        await this.cli.call(
          repo,
          ["worktree", "list", "--porcelain", "-z"],
          signal ? { signal } : {},
        )
      ).stdout,
    );
  }

  async status(root: string): Promise<Status> {
    return (await this.state(root)).status;
  }

  /** `directoryFd`: run in that held directory instead of entering `root` by path. */
  async state(root: string, env: Record<string, string> = {}, directoryFd?: number) {
    return parseStatus(
      (
        await this.cli.call(
          root,
          [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--ahead-behind",
            "--no-show-stash",
            "--untracked-files=all",
            "--renames",
            "--ignore-submodules=none",
          ],
          { env, directoryFd },
        )
      ).stdout,
    );
  }

  async info(root: string): Promise<RepositoryInfo> {
    const { branch } = await this.state(root);
    return { root, ...branch, remotes: await this.remotes(root) };
  }

  /** Configured remotes, re-read only once a Git config file the checkout uses has changed. */
  remotes(root: string): Promise<RepositoryInfo["remotes"]> {
    return this.cli.configFact(root, "remotes", async () => {
      const remotes = await this.cli.call(
        root,
        ["config", "-z", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
        { allowFailure: true },
      );
      if (remotes.exitCode !== 0 && remotes.exitCode !== 1) {
        throw new GitError("git_failed", remotes.stderr);
      }
      return parseRemotes(remotes.stdout);
    });
  }

  /** `directoryFd`: run in that held directory instead of entering `root` by path. */
  async commit(
    root: string,
    ref: string,
    signal?: AbortSignal,
    directoryFd?: number,
  ): Promise<string> {
    if (!ref || ref.includes("\0")) throw new GitError("invalid_ref", "A commit ref is required");
    const result = await this.cli.call(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { allowFailure: true, directoryFd, ...(signal ? { signal } : {}) },
    );
    if (result.exitCode !== 0) {
      // HEAD naming a branch that has no commit yet is a new repository, not a bad ref.
      if (
        ref === "HEAD" &&
        (
          await this.cli.call(root, ["symbolic-ref", "--quiet", "HEAD"], {
            allowFailure: true,
            directoryFd,
          })
        ).exitCode === 0
      )
        throw new GitError("unborn_head", "The repository has no commits yet");
      throw new GitError("invalid_ref", `Commit not found: ${ref}`);
    }
    return hash(textOutput(result));
  }
}
