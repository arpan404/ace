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
import { resolveCommitRef, worktreeRecords } from "./native-refs.ts";
import { GitError, type RepositoryInfo, type Status, type Worktree } from "./types.ts";

export interface RepositoryOptions {
  checkpointCounterCacheSize?: number | undefined;
  /** False with a non-default `gitBinary` or an injected `spawn`: ref reads stay TypeScript. */
  nativeRefsAllowed?: boolean | undefined;
}

export class Repository {
  readonly cli: GitCli;
  readonly numbers: CheckpointNumbers;
  readonly now: () => Date | Promise<Date>;
  readonly tempDirectory: string;
  /** Whether `ACE_GIT=refs` may serve this instance's ref reads (no injected binary or spawn). */
  readonly nativeRefsAllowed: boolean;

  constructor(
    cli: GitCli,
    now: () => Date | Promise<Date>,
    tempDirectory: string,
    options: RepositoryOptions = {},
  ) {
    this.cli = cli;
    this.numbers = new CheckpointNumbers(cli, options.checkpointCounterCacheSize);
    this.now = now;
    this.tempDirectory = tempDirectory;
    this.nativeRefsAllowed = options.nativeRefsAllowed ?? true;
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
    const trees = parseWorktrees(await worktreeRecords(this, repo, signal));
    return this.cli.platform === "win32" ? nativeWorktreePaths(trees) : trees;
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

  /** HEAD, or null on a branch that has no commit yet. */
  async head(root: string, signal?: AbortSignal): Promise<string | null> {
    try {
      return await this.commit(root, "HEAD", signal);
    } catch (error) {
      // HEAD naming a branch with no commit yet is an empty repository, not a bad ref.
      if (error instanceof GitError && error.code === "unborn_head") return null;
      throw error;
    }
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
    const resolved = await resolveCommitRef(this, root, ref, signal, directoryFd);
    if (resolved.kind === "commit") return hash(resolved.id);
    // HEAD naming a branch that has no commit yet is a new repository, not a bad ref.
    if (resolved.kind === "unborn")
      throw new GitError("unborn_head", "The repository has no commits yet");
    throw new GitError("invalid_ref", `Commit not found: ${ref}`);
  }
}
