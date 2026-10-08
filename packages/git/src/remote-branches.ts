import { BranchRef } from "@ace/protocol";
import { z } from "zod";
import { textOutput } from "./cli.ts";
import { hash } from "./decode.ts";
import { GitDiagnostics } from "./diagnostics.ts";
import { defaultBranch } from "./projects.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/** Same bound as `listBranches`. */
const refLimit = 1000;
const timeout = z.number().int().positive().max(2_147_483_647);

export interface BranchRefs {
  refs: BranchRef[];
  defaultBranch: string;
  truncated: boolean;
}

/**
 * Local branches (with their upstream and how far they are from it, as of the last fetch) and
 * remotes' branches, from one `for-each-ref`. No network.
 */
export async function branchRefs(repository: Repository, worktree: string): Promise<BranchRefs> {
  const root = await repository.root(worktree);
  const [listing, remotes, base] = await Promise.all([
    repository.cli.call(
      root,
      [
        "for-each-ref",
        `--count=${refLimit + 1}`,
        "--format=%(refname)%00%(symref)%00%(upstream:short)%00%(upstream:track,nobracket)",
        "refs/heads",
        "refs/remotes",
      ],
      { captureBytes: 8 * 1_048_576 },
    ),
    remoteNames(repository, root),
    defaultBranch(repository.cli, root),
  ]);
  if (listing.truncated) throw new GitError("output_too_large", "Branch listing exceeded 8 MiB");
  const lines = listing.stdout.toString("utf8").split("\n").filter(Boolean);
  const refs = lines
    .slice(0, refLimit)
    .flatMap((line) => parseRef(line, remotes))
    .slice(0, refLimit);
  return { refs, defaultBranch: base, truncated: lines.length > refLimit };
}

function parseRef(line: string, remotes: readonly string[]): BranchRef[] {
  const [refname = "", symref = "", upstream = "", track = ""] = line.split("\0");
  // A remote's `HEAD` (and any other symbolic ref) names another branch, not one of its own.
  if (symref) return [];
  if (refname.startsWith("refs/heads/")) {
    const name = refname.slice("refs/heads/".length);
    const parsed = BranchRef.safeParse({
      name,
      ...(upstream ? { upstream, ...trackCounts(track) } : {}),
    });
    return parsed.success ? [parsed.data] : [];
  }
  const rest = refname.slice("refs/remotes/".length);
  // Branch names can contain `/`; remote names are matched against the configured ones.
  const remote = remotes
    .filter((name) => rest.startsWith(`${name}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  if (!remote) return [];
  const parsed = BranchRef.safeParse({ name: rest.slice(remote.length + 1), remote });
  return parsed.success ? [parsed.data] : [];
}

/** `ahead 1, behind 2` / `ahead 1` / `behind 2` / `` (in sync) / `gone` (upstream deleted). */
function trackCounts(track: string): { ahead?: number; behind?: number } {
  if (track === "gone") return {};
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return { ahead: Number(ahead ?? 0), behind: Number(behind ?? 0) };
}

async function remoteNames(repository: Repository, root: string): Promise<string[]> {
  const result = await repository.cli.call(root, ["remote"], { captureBytes: 1_048_576 });
  return result.stdout.toString("utf8").split("\n").filter(Boolean);
}

async function assertBranchName(repository: Repository, root: string, branch: string) {
  const checked = await repository.cli.call(root, ["check-ref-format", "--branch", branch], {
    allowFailure: true,
  });
  // `--branch` expands `@{-1}`; only a literal name is a branch here.
  if (branch.startsWith("-") || checked.exitCode !== 0 || textOutput(checked) !== branch)
    throw new GitError("invalid_ref", `Invalid branch name: ${branch}`);
}

async function assertRemote(repository: Repository, root: string, remote: string) {
  if (!(await remoteNames(repository, root)).includes(remote))
    throw new GitError("invalid_argument", `No remote named ${remote}`);
}

/**
 * The commit a local branch (`remote` absent) or a remote-tracking branch points at, or
 * undefined when that ref doesn't exist. Never reads revision syntax: the name must be a branch.
 */
export async function branchHead(
  repository: Repository,
  options: { repo: string; branch: string; remote?: string | undefined },
): Promise<string | undefined> {
  const root = await repository.root(options.repo);
  await assertBranchName(repository, root, options.branch);
  if (options.remote !== undefined) await assertRemote(repository, root, options.remote);
  const ref =
    options.remote === undefined
      ? `refs/heads/${options.branch}`
      : `refs/remotes/${options.remote}/${options.branch}`;
  const result = await repository.cli.call(
    root,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { allowFailure: true },
  );
  return result.exitCode === 0 ? hash(textOutput(result)) : undefined;
}

export interface FetchBranchOptions {
  repo: string;
  remote: string;
  branch: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  stderr?: (chunk: Buffer) => void;
}

/**
 * Fetch one branch into its remote-tracking ref (`refs/remotes/<remote>/<branch>`) and nothing
 * else: no tags, submodules, `FETCH_HEAD` or maintenance, and never the working tree, index,
 * HEAD or local branches. Never prompts.
 *
 * Deliberately outside the repository's mutation lease: a fetch killed by its deadline (an
 * unreachable host, a hung transport) only ever had that one ref's update in flight, which Git
 * guards with its own lock, so it must not quarantine the repository the way a killed writer of
 * the working tree does. Concurrent callers are serialized by Git's ref locking.
 *
 * Failures: `remote_ref_not_found` (the remote has no such branch), `auth_failed`,
 * `remote_unreachable`, `git_timeout`, `git_cancelled`; `invalid_ref` / `invalid_argument` for a
 * bad branch name or an unconfigured remote.
 */
export async function fetchBranch(
  repository: Repository,
  options: FetchBranchOptions,
): Promise<void> {
  const deadline = timeout.safeParse(options.timeoutMs);
  if (!deadline.success)
    throw new GitError("invalid_argument", "timeoutMs must be an integer between 1 and 2147483647");
  const root = await repository.root(options.repo);
  await assertBranchName(repository, root, options.branch);
  await assertRemote(repository, root, options.remote);
  // Only replace ssh's command when the person hasn't configured their own.
  const configured = await repository.cli.call(root, ["config", "--get", "core.sshCommand"], {
    allowFailure: true,
  });
  const env: Record<string, string> = {
    GCM_INTERACTIVE: "never",
    ...(configured.exitCode === 1 ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
  };
  let result;
  try {
    result = await repository.cli.call(
      root,
      [
        "fetch",
        "--progress",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--end-of-options",
        options.remote,
        `+refs/heads/${options.branch}:refs/remotes/${options.remote}/${options.branch}`,
      ],
      {
        write: true,
        allowFailure: true,
        captureBytes: 65_536,
        timeoutMs: deadline.data,
        signal: options.signal,
        ...(options.stderr ? { stderr: options.stderr } : {}),
        env,
      },
    );
  } catch (error) {
    // No mutation lease is held, so a killed fetch quarantines nothing; don't hand callers a
    // cleanup receipt that would read as "repository unavailable".
    if (error instanceof GitError && error.cleanup)
      throw new GitError(error.code, error.message, { ...error.details });
    throw error;
  }
  if (result.exitCode !== 0) throw fetchFailure(result.stderr);
}

function fetchFailure(stderr: string): GitError {
  const diagnostics = new GitDiagnostics();
  diagnostics.accept(Buffer.from(stderr));
  if (diagnostics.finish() === "auth_failed")
    return new GitError("auth_failed", "The remote refused the credentials");
  if (/couldn't find remote ref/i.test(stderr))
    return new GitError("remote_ref_not_found", "The remote has no such branch");
  if (/cannot lock ref|unable to update local ref/i.test(stderr))
    return new GitError("git_failed", "Could not update the remote-tracking branch");
  return new GitError("remote_unreachable", "Could not reach the remote");
}
