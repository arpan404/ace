import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { longWriteTimeoutMs } from "./deadlines.ts";
import { GitDiagnostics } from "./diagnostics.ts";
import { failureMessage } from "./failure-text.ts";
import { remoteNames } from "./remote-branches.ts";
import type { Repository } from "./repository.ts";
import { GitError, type GitStash } from "./types.ts";

const maxPathBytes = 256 * 1024;
const maxPaths = 1000;
const maxStashes = 200;
const literalEnv = { GIT_LITERAL_PATHSPECS: "1" };

const remoteName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w./-]+$/)
  .refine((value) => !value.startsWith("-"));

const stashRefSchema = z.string().regex(/^stash@\{\d+\}$/);

/**
 * Validate repository-relative paths so none escape `root`, target `.git`, or pass empty/NUL
 * pathspecs to Git. Pure: operates on strings and `path.resolve`/`relative`.
 */
export function validateRepoPaths(root: string, paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > maxPaths)
    throw new GitError("invalid_argument", `Name between 1 and ${maxPaths} paths`);
  let totalBytes = 0;
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const raw of paths) {
    if (!raw || raw.length > 4096 || raw.includes("\0"))
      throw new GitError("path_outside_repo", "Path is invalid or contains NUL bytes");
    if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw) || isAbsolute(raw)) {
      throw new GitError("path_outside_repo", "Absolute paths are not allowed");
    }
    const segments = raw.split(/[/\\]/);
    if (
      segments.some((segment) => segment === "..") ||
      segments[0]?.toLowerCase() === ".git" ||
      segments.some((segment) => segment.toLowerCase() === ".git") ||
      raw === "."
    ) {
      throw new GitError("path_outside_repo", "Path escapes the repository or targets .git");
    }
    const target = resolve(root, raw);
    const rel = relative(root, target);
    if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel))
      throw new GitError("path_outside_repo", "Path escapes the repository root");
    totalBytes += Buffer.byteLength(raw) + 1;
    if (totalBytes > maxPathBytes)
      throw new GitError("invalid_argument", "Total pathspec length exceeds limit");
    if (!seen.has(raw)) {
      seen.add(raw);
      valid.push(raw);
    }
  }
  return valid;
}

/** Parse `git stash list --format=%gd%x00%gs` output into structured stash entries. Pure. */
export function parseStashList(output: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const sep = line.indexOf("\0");
    if (sep < 0) continue;
    const ref = line.slice(0, sep);
    const subject = line.slice(sep + 1);
    const match = /^stash@\{(\d+)\}$/.exec(ref);
    if (!match) continue;
    const index = Number(match[1]);
    const branchMatch = /^(?:WIP on|On) ([^:]+):\s*(.*)$/.exec(subject);
    const branch = branchMatch?.[1];
    const message = (branchMatch ? branchMatch[2] : subject).slice(0, 1024);
    stashes.push({
      ref,
      index,
      message: message || subject.slice(0, 1024),
      ...(branch ? { branch } : {}),
    });
    if (stashes.length >= maxStashes) break;
  }
  return stashes;
}

/** Stage specified paths, or every change in the checkout when `paths` is omitted. */
export async function stagePaths(
  repository: Repository,
  options: { worktree: string; paths?: readonly string[] | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const paths = options.paths ? validateRepoPaths(root, options.paths) : undefined;
  await repository.serial(root, async () => {
    const args = paths ? ["add", "--all", "--", ...paths] : ["add", "--all", "--", "."];
    await repository.cli.call(root, args, {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
      env: literalEnv,
    });
  });
}

/** Unstage specified paths, or every staged change when `paths` is omitted. */
export async function unstagePaths(
  repository: Repository,
  options: { worktree: string; paths?: readonly string[] | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const paths = options.paths ? validateRepoPaths(root, options.paths) : undefined;
  await repository.serial(root, async () => {
    const info = await repository.info(root);
    if (info.head === null) {
      const args = paths
        ? ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths]
        : ["rm", "--cached", "-r", "--ignore-unmatch", "--", "."];
      await repository.cli.call(root, args, {
        write: true,
        timeoutMs: longWriteTimeoutMs,
        captureBytes: 65_536,
        env: literalEnv,
      });
      return;
    }
    const args = paths ? ["reset", "HEAD", "--", ...paths] : ["reset", "HEAD", "--"];
    await repository.cli.call(root, args, {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
      env: literalEnv,
    });
  });
}

/**
 * Discard working-tree changes. Tracked files are restored from the index (or HEAD if only staged
 * and already tracked in HEAD). Untracked files are sent through `trash` (Recently deleted); if
 * `trash` is unavailable, refuses with `trash_unavailable` and never deletes directly.
 */
export async function discardPaths(
  repository: Repository,
  options: {
    worktree: string;
    paths?: readonly string[] | undefined;
    includeUntracked?: boolean | undefined;
    trash?: ((root: string, path: string) => Promise<void>) | undefined;
  },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const requested = options.paths ? validateRepoPaths(root, options.paths) : undefined;
  await repository.serial(root, async () => {
    const { status, branch } = await repository.state(root);
    const untrackedSet = new Set(status.untracked);
    const unstagedSet = new Set(status.unstaged.map((entry) => entry.path));
    const stagedByPath = new Map(status.staged.map((entry) => [entry.path, entry]));
    const restoreFromIndex: string[] = [];
    const restoreFromHead: string[] = [];
    const unstageAdded: string[] = [];
    const toTrash: string[] = [];

    if (requested) {
      for (const path of requested) {
        if (untrackedSet.has(path)) {
          toTrash.push(path);
        } else if (unstagedSet.has(path)) {
          restoreFromIndex.push(path);
        } else {
          const staged = stagedByPath.get(path);
          if (!staged) continue;
          if (staged.indexStatus === "A" || branch.head === null) {
            unstageAdded.push(path);
            toTrash.push(path);
          } else {
            restoreFromHead.push(path);
          }
        }
      }
    } else {
      for (const entry of status.unstaged) restoreFromIndex.push(entry.path);
      if (options.includeUntracked) toTrash.push(...status.untracked);
    }

    if (toTrash.length > 0 && !options.trash) {
      throw new GitError("trash_unavailable", failureMessage("trash_unavailable"));
    }
    if (restoreFromIndex.length > 0) {
      await repository.cli.call(root, ["checkout", "--", ...restoreFromIndex], {
        write: true,
        timeoutMs: longWriteTimeoutMs,
        captureBytes: 65_536,
        env: literalEnv,
      });
    }
    if (restoreFromHead.length > 0) {
      await repository.cli.call(root, ["checkout", "HEAD", "--", ...restoreFromHead], {
        write: true,
        timeoutMs: longWriteTimeoutMs,
        captureBytes: 65_536,
        env: literalEnv,
      });
    }
    if (unstageAdded.length > 0) {
      if (branch.head === null) {
        await repository.cli.call(
          root,
          ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...unstageAdded],
          { write: true, timeoutMs: longWriteTimeoutMs, captureBytes: 65_536, env: literalEnv },
        );
      } else {
        await repository.cli.call(root, ["reset", "HEAD", "--", ...unstageAdded], {
          write: true,
          timeoutMs: longWriteTimeoutMs,
          captureBytes: 65_536,
          env: literalEnv,
        });
      }
    }
    if (toTrash.length > 0 && options.trash) {
      for (const path of toTrash) {
        await options.trash(root, path);
      }
    }
  });
}

/** Create a new local branch at HEAD and switch to it. */
export async function createBranch(
  repository: Repository,
  options: { worktree: string; branch: string },
): Promise<void> {
  const root = await repository.root(options.worktree);
  await repository.serial(root, async () => {
    const valid = await repository.cli.call(
      root,
      ["check-ref-format", "--branch", options.branch],
      { allowFailure: true },
    );
    if (
      !options.branch ||
      options.branch.startsWith("-") ||
      valid.exitCode !== 0 ||
      valid.stdout.toString("utf8").trim() !== options.branch
    )
      throw new GitError("invalid_ref", "Invalid branch name");
    const existing = await repository.cli.call(
      root,
      ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`],
      { allowFailure: true },
    );
    if (existing.exitCode === 0)
      throw new GitError("branch_exists", `Branch already exists: ${options.branch}`);
    const status = await repository.status(root);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before creating a branch");
    await repository.cli.call(root, ["switch", "-c", options.branch], {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      env: { GIT_TRACE2_EVENT: "1" },
    });
  });
}

async function transportEnv(repository: Repository, root: string): Promise<Record<string, string>> {
  const configured = await repository.cli.call(root, ["config", "--get", "core.sshCommand"], {
    allowFailure: true,
  });
  return {
    GCM_INTERACTIVE: "never",
    ...(configured.exitCode === 1 ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
  };
}

function classifyFetchError(stderr: string): GitError {
  const diagnostics = new GitDiagnostics();
  diagnostics.accept(Buffer.from(stderr));
  if (diagnostics.finish() === "auth_failed")
    return new GitError("auth_failed", "The remote refused the credentials", { stderr });
  if (/couldn't find remote ref/i.test(stderr))
    return new GitError("remote_ref_not_found", "The remote has no such branch", { stderr });
  if (/cannot lock ref|unable to update local ref/i.test(stderr))
    return new GitError("git_failed", "Could not update remote-tracking refs", { stderr });
  return new GitError("remote_unreachable", "Could not reach the remote", { stderr });
}

async function resolveRemote(
  repository: Repository,
  root: string,
  branch: string | null,
  requested?: string,
): Promise<string> {
  const remotes = await remoteNames(repository, root);
  if (requested !== undefined) {
    const name = remoteName.parse(requested);
    if (!remotes.includes(name)) throw new GitError("invalid_argument", `No remote named ${name}`);
    return name;
  }
  if (branch) {
    const configured = await repository.cli.call(
      root,
      ["config", "--get", `branch.${branch}.remote`],
      { allowFailure: true },
    );
    const branchRemote = configured.exitCode === 0 ? configured.stdout.toString("utf8").trim() : "";
    if (branchRemote && remotes.includes(branchRemote)) return branchRemote;
  }
  if (remotes.includes("origin")) return "origin";
  const first = remotes[0];
  if (first) return first;
  throw new GitError("no_upstream", failureMessage("no_upstream"));
}

/** Fetch updates from a remote (default: branch's upstream remote or origin) with pruning. */
export async function fetchRemote(
  repository: Repository,
  options: { worktree: string; remote?: string | undefined; timeoutMs?: number | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const info = await repository.info(root);
  const remote = await resolveRemote(repository, root, info.branch, options.remote);
  const env = await transportEnv(repository, root);
  const result = await repository.cli.fetch(
    root,
    [
      "fetch",
      "--prune",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--end-of-options",
      remote,
    ],
    {
      write: true,
      allowFailure: true,
      captureBytes: 65_536,
      timeoutMs: options.timeoutMs ?? 60_000,
      env,
    },
  );
  if (result.exitCode !== 0) throw classifyFetchError(result.stderr);
}

/**
 * Fetch and fast-forward the current branch (`--ff-only`). Refuses diverged branches with
 * `pull_diverged`, missing upstreams with `no_upstream`, and conflicting local edits with
 * `dirty_worktree` / `conflicts`.
 */
export async function pullBranch(
  repository: Repository,
  options: { worktree: string; remote?: string | undefined; timeoutMs?: number | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  await repository.serial(root, async () => {
    const { status, branch } = await repository.state(root);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before pulling");
    if (!branch.branch || branch.detached)
      throw new GitError("invalid_ref", "Switch to a branch before pulling");
    if (!branch.upstream && !options.remote)
      throw new GitError("no_upstream", failureMessage("no_upstream"));
    const remote = await resolveRemote(repository, root, branch.branch, options.remote);
    const env = await transportEnv(repository, root);
    const fetched = await repository.cli.fetch(
      root,
      [
        "fetch",
        "--prune",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--end-of-options",
        remote,
      ],
      {
        write: true,
        allowFailure: true,
        captureBytes: 65_536,
        timeoutMs: options.timeoutMs ?? 60_000,
        env,
      },
    );
    if (fetched.exitCode !== 0) throw classifyFetchError(fetched.stderr);

    let targetRef: string;
    if (branch.upstream) {
      const upstream = await repository.cli.call(
        root,
        ["rev-parse", "--verify", "--symbolic-full-name", "@{upstream}"],
        { allowFailure: true },
      );
      if (upstream.exitCode !== 0)
        throw new GitError("remote_ref_not_found", "The upstream branch no longer exists");
      targetRef = upstream.stdout.toString("utf8").trim();
    } else {
      targetRef = `refs/remotes/${remote}/${branch.branch}`;
      const verify = await repository.cli.call(
        root,
        ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`],
        { allowFailure: true },
      );
      if (verify.exitCode !== 0)
        throw new GitError("remote_ref_not_found", "The branch does not exist on the remote");
    }

    const merged = await repository.cli.call(root, ["merge", "--ff-only", "--", targetRef], {
      write: true,
      allowFailure: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
      env: { GIT_TRACE2_EVENT: "1" },
    });
    if (merged.exitCode !== 0) {
      const stderr = merged.stderr;
      if (/not possible to fast-forward|diverging branches/i.test(stderr))
        throw new GitError("pull_diverged", failureMessage("pull_diverged"), { stderr });
      if (/would be overwritten by merge|local changes to the following files/i.test(stderr))
        throw new GitError("dirty_worktree", "Local changes would be overwritten by pulling", {
          stderr,
        });
      if (/conflict|unmerged/i.test(stderr))
        throw new GitError("conflicts", "Pull resulted in conflicts", { stderr });
      throw new GitError("git_failed", "Could not pull from upstream", { stderr });
    }
  });
}

/** List stashes in the checkout, newest first. */
export async function stashList(repository: Repository, worktree: string): Promise<GitStash[]> {
  const root = await repository.root(worktree);
  return repository.serial(root, async () => {
    const result = await repository.cli.call(root, ["stash", "list", "--format=%gd%x00%gs"], {
      captureBytes: 1_048_576,
    });
    return parseStashList(result.stdout.toString("utf8"));
  });
}

/** Push local changes onto the stash stack. */
export async function stashPush(
  repository: Repository,
  options: {
    worktree: string;
    message?: string | undefined;
    includeUntracked?: boolean | undefined;
  },
): Promise<void> {
  const root = await repository.root(options.worktree);
  if (options.message !== undefined && options.message.includes("\0"))
    throw new GitError("invalid_argument", "Stash message cannot contain NUL bytes");
  await repository.serial(root, async () => {
    const status = await repository.status(root);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before stashing");
    const hasChanges =
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      (Boolean(options.includeUntracked) && status.untracked.length > 0);
    if (!hasChanges) throw new GitError("nothing_to_stash", failureMessage("nothing_to_stash"));
    const args = [
      "stash",
      "push",
      ...(options.includeUntracked ? ["--include-untracked"] : []),
      ...(options.message?.trim() ? ["-m", options.message.trim().slice(0, 1024)] : []),
    ];
    await repository.cli.call(root, args, {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
    });
  });
}

/** Pop a stash (latest when `stash` is omitted). */
export async function stashPop(
  repository: Repository,
  options: { worktree: string; stash?: string | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const ref = options.stash === undefined ? undefined : stashRefSchema.parse(options.stash);
  await repository.serial(root, async () => {
    const listed = await repository.cli.call(root, ["stash", "list", "--format=%gd%x00%gs"], {
      captureBytes: 1_048_576,
    });
    const stashes = parseStashList(listed.stdout.toString("utf8"));
    if (stashes.length === 0 || (ref !== undefined && !stashes.some((entry) => entry.ref === ref)))
      throw new GitError("stash_empty", failureMessage("stash_empty"));
    const args = ref ? ["stash", "pop", ref] : ["stash", "pop"];
    const result = await repository.cli.call(root, args, {
      write: true,
      allowFailure: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
    });
    if (result.exitCode !== 0) {
      const combined = `${result.stderr}\n${result.stdout.toString("utf8")}`;
      if (/conflict|could not restore untracked/i.test(combined))
        throw new GitError("conflicts", "Popping the stash resulted in conflicts", {
          stderr: result.stderr,
        });
      if (/would be overwritten|local changes to the following files/i.test(combined))
        throw new GitError(
          "dirty_worktree",
          "Local changes would be overwritten by popping stash",
          {
            stderr: result.stderr,
          },
        );
      throw new GitError("git_failed", "Could not pop stash", { stderr: result.stderr });
    }
  });
}
