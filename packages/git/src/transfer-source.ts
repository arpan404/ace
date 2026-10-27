import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { textOutput } from "./cli.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/** What a folder about to be sent is, as far as Git is concerned. */
export type SourceCheckout =
  /** Inside a work tree whose top is `root` (canonical); `root` may be the folder itself. */
  | { kind: "checkout"; root: string }
  /** Not in any work tree: a plain folder. */
  | { kind: "folder" }
  /** In a repository Git refuses to read because another user owns it (`safe.directory`). */
  | { kind: "untrusted" };

/** True when `path` or a folder above it holds a `.git` entry (a folder or a worktree's file). */
export async function gitAbove(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (dirname(current) === current) return false;
  }
}

/**
 * Tells a work tree from a plain folder without treating every Git failure as "not a repository".
 * A plain folder is one with no `.git` anywhere above that Git calls not a repository, or that
 * can't be asked because Git is missing. Any other failure throws, so a broken repository is
 * never mistaken for a folder to copy whole.
 */
export async function sourceCheckout(
  repository: Repository,
  path: string,
): Promise<SourceCheckout> {
  const cwd = await realpath(path);
  let inside;
  try {
    inside = await repository.cli.call(cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowFailure: true,
    });
  } catch (error) {
    if (error instanceof GitError && error.code === "git_missing" && !(await gitAbove(cwd)))
      return { kind: "folder" };
    throw error;
  }
  if (inside.exitCode === 0)
    return textOutput(inside) === "true"
      ? { kind: "checkout", root: await repository.root(cwd) }
      : { kind: "folder" };
  if (/dubious ownership/i.test(inside.stderr)) return { kind: "untrusted" };
  // A `.git` here or above that Git can't use (a broken worktree link, a damaged HEAD) is a
  // broken repository, not a plain folder.
  if (/not a git repository/i.test(inside.stderr) && !(await gitAbove(cwd)))
    return { kind: "folder" };
  throw new GitError("git_failed", "Git couldn't read the repository", {
    stderr: inside.stderr.slice(-2048),
  });
}
