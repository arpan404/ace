// SPDX-License-Identifier: Apache-2.0

/**
 * The native refs shell (G1): the ref, branch and worktree-list reads on `gix`, inside
 * today's TypeScript service. Each function here replaces one Git process of
 * `Repository.commit`/`worktrees`, `branchHead`, `listBranches` or `branchRefs`; the caller
 * still decodes what the process printed (`parseWorktrees`, `parseRef`, `parseBranches`) and
 * still words its own errors. A read `gix` cannot reproduce exactly falls back to the same
 * Git command in the same call and `serial` turn, and is counted by reason; the shell's own
 * reasons are `injected` (a non-default `gitBinary` or an injected `spawn`) and
 * `directory_fd` (a held directory the supervisor can't spawn in yet).
 *
 * A read runs on a worker thread, never the JavaScript thread: the caller's `AbortSignal`
 * and `GitCli`'s deadline stop it through a token the core polls, and the promise rejects
 * with the same `git_cancelled`/`git_timeout` errors the CLI path raises.
 */
import { Buffer } from "node:buffer";
import {
  gitCrossSelected,
  gitPartOn,
  type GitPart,
  type NativeBackend,
} from "@ace/provider-kit/native-switches";
import { textOutput } from "./cli.ts";
import { windowsHooklessArgs } from "./disabled-hooks.ts";
import {
  countGitFallback,
  gitAddon,
  type NativeReply,
  type NativeSettle,
  recordGitOp,
  reserveGitOpSeq,
  throwGitError,
} from "./native-common.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

const part = "refs" satisfies GitPart;

/** `listRefs`'s capture bound, and the largest branch listing one reply carries. */
const branchListingBytes = 8 * 1_048_576;
/** `listBranches`'s capture bound, and the largest name listing one reply carries. */
const branchNamesBytes = 1_048_576;

/** The five reads this shell serves, named as the operation log names them. */
type RefsOp = "listWorktrees" | "branches" | "branchRefs" | "resolveCommit" | "branchHead";

/** What `Repository.commit` needs from `rev-parse --verify <ref>^{commit}` and the unborn check. */
export type CommitKind = { kind: "commit"; id: string } | { kind: "unborn" } | { kind: "missing" };

interface Logged {
  seq: number;
  op: RefsOp;
  selected: NativeBackend;
  completed: NativeBackend;
  fallback?: string;
}

function record({ seq, op, selected, completed, fallback }: Logged): void {
  recordGitOp({
    seq,
    op,
    part,
    selected,
    completed,
    ...(fallback === undefined ? {} : { fallback }),
  });
}

function fallbackReason(seq: number, fallback: string, op: RefsOp, selected: NativeBackend): void {
  record({ seq, op, selected, completed: "typescript", fallback });
  countGitFallback(fallback);
}

/** One read's promise, settled by the addon's callback on the JavaScript thread. */
function settled(start: (settle: NativeSettle) => void): Promise<NativeReply> {
  return new Promise<NativeReply>((resolve, reject) => {
    start((error, reply) => {
      if (error !== null && error !== undefined) {
        try {
          throwGitError(error);
        } catch (mapped) {
          reject(mapped);
        }
        return;
      }
      if (reply === undefined) {
        reject(new GitError("git_failed", "ace-git refs reply is empty"));
        return;
      }
      resolve(reply);
    });
  });
}

/**
 * Runs one native read on the binding's own worker pool. `GitCli` admits it like a process
 * (the 64-call limit and the `close()` drain) and the caller's signal or the call's deadline
 * stops it through the token the core polls; the promise then rejects with the error `GitCli`
 * would raise for the same process. A task keeps its admission slot and token until it ends.
 */
async function invoke(
  repository: Repository,
  timeoutMs: number,
  args: readonly string[],
  read: (token: number, settle: NativeSettle) => void,
  signal?: AbortSignal,
): Promise<NativeReply> {
  const addon = gitAddon();
  let token: number | undefined;
  const native = repository.cli.nativeCall(() => {
    token = addon.gitRefsAbortToken();
    const started = token;
    return settled((settle) => read(started, settle));
  });
  const stop = () => {
    if (token !== undefined) addon.gitRefsAbort(token);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      stop();
      reject(new GitError("git_cancelled", "Git operation cancelled before dispatch"));
      return;
    }
    onAbort = () => {
      stop();
      reject(new GitError("git_cancelled", "Git operation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      stop();
      // Windows runs Git with rewritten arguments; its deadline error names those.
      const timed =
        repository.cli.platform === "win32" ? windowsHooklessArgs([...args]) : [...args];
      reject(new GitError("git_timeout", `Git exceeded ${timeoutMs}ms`, { args: timed }));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([native, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs one ref read: native when the part is on and this call may use it, the same Git
 * command otherwise. `ineligible` names why a native selection may not run, and is recorded
 * as its fallback; `accept` reads the addon's reply and names the fallback it asked for.
 */
async function run<T>(
  repository: Repository,
  op: RefsOp,
  ineligible: string | undefined,
  args: readonly string[],
  attempt: (token: number, settle: NativeSettle) => void,
  typescript: () => Promise<T>,
  accept: (reply: NativeReply) => { data: T } | { fallback: string },
  signal?: AbortSignal,
): Promise<T> {
  // `GitCli` refuses an aborted call before dispatching; a cancelled call is no operation.
  if (signal?.aborted)
    throw new GitError("git_cancelled", "Git operation cancelled before dispatch");
  const selected: NativeBackend = gitCrossSelected() ?? "native";
  // Reserved before the await: three listings of one `branchRefs` finish in any order, and
  // the cross gate reads the selections in the order they were made.
  const seq = reserveGitOpSeq();
  if (selected === "typescript") {
    record({ seq, op, selected, completed: "typescript" });
    return typescript();
  }
  if (ineligible !== undefined) {
    fallbackReason(seq, ineligible, op, selected);
    return typescript();
  }
  let accepted: { data: T } | { fallback: string };
  try {
    accepted = accept(await invoke(repository, repository.cli.timeoutMs, args, attempt, signal));
  } catch (error) {
    record({ seq, op, selected, completed: "native" });
    throwGitError(error);
  }
  if ("fallback" in accepted) {
    if (accepted.fallback === "cancelled") {
      // The caller's abort stopped the read: it is cancelled, never rerun on the CLI.
      record({ seq, op, selected, completed: "native" });
      throw new GitError("git_cancelled", "Git operation cancelled");
    }
    fallbackReason(seq, accepted.fallback, op, selected);
    return typescript();
  }
  record({ seq, op, selected, completed: "native" });
  return accepted.data;
}

/** Why a refs read may not run natively in this call, or `undefined` when it may. */
function injected(repository: Repository): string | undefined {
  return repository.nativeRefsAllowed ? undefined : "injected";
}

/** The fallback reason an `ace-json` reply names, or `undefined` when it carries data. */
function fallbackOf(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object" || !("fallback" in parsed)) return undefined;
  const fallback = (parsed as { fallback?: unknown }).fallback;
  return typeof fallback === "string" ? fallback : undefined;
}

/** The bytes of a listing, or the reason the CLI has to print it. */
function listingReply(reply: NativeReply): { data: Buffer } | { fallback: string } {
  if (typeof reply === "string") {
    const fallback = fallbackOf(JSON.parse(reply));
    if (fallback === undefined)
      throw new GitError("git_failed", "ace-git refs reply is not a listing");
    return { fallback };
  }
  return { data: Buffer.from(reply) };
}

/** One `ace-json` value, or the reason the CLI has to answer instead. */
function valueReply<T>(reply: NativeReply): { data: T } | { fallback: string } {
  if (typeof reply !== "string") throw new GitError("git_failed", "ace-git refs reply is not JSON");
  const parsed: unknown = JSON.parse(reply);
  const fallback = fallbackOf(parsed);
  return fallback === undefined ? { data: parsed as T } : { fallback };
}

/** `Repository.worktrees`: the records `worktree list --porcelain -z` prints. */
export async function worktreeRecords(
  repository: Repository,
  repo: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const args = ["worktree", "list", "--porcelain", "-z"] as const;
  const typescript = async () =>
    (await repository.cli.call(repo, [...args], signal ? { signal } : {})).stdout;
  if (!gitPartOn(part)) return typescript();
  return run(
    repository,
    "listWorktrees",
    injected(repository),
    args,
    (token, settle) => gitAddon().gitRefsWorktrees(token, repo, settle),
    typescript,
    listingReply,
    signal,
  );
}

/**
 * `branchRefs`'s listing: `for-each-ref`'s lines in `-committerdate`, then `refname`, with
 * `--count`, capped at 8 MiB.
 */
export async function branchRefLines(
  repository: Repository,
  root: string,
  patterns: readonly string[],
  count: number,
): Promise<Buffer> {
  const args = [
    "for-each-ref",
    ...(count > 0 ? [`--count=${count}`] : []),
    "--sort=refname",
    "--sort=-committerdate",
    "--format=%(refname)%00%(symref)%00%(upstream:short)%00%(upstream:track,nobracket)",
    "--end-of-options",
    ...patterns,
  ];
  const typescript = async () => {
    const listing = await repository.cli.call(root, args, { captureBytes: branchListingBytes });
    if (listing.truncated) throw new GitError("output_too_large", "Branch listing exceeded 8 MiB");
    return listing.stdout;
  };
  if (!gitPartOn(part)) return typescript();
  return run(
    repository,
    "branchRefs",
    injected(repository),
    args,
    (token, settle) => gitAddon().gitRefsBranchListing(token, root, [...patterns], count, settle),
    typescript,
    (reply) => {
      const accepted = listingReply(reply);
      if ("data" in accepted && accepted.data.length > branchListingBytes)
        throw new GitError("output_too_large", "Branch listing exceeded 8 MiB");
      return accepted;
    },
  );
}

/** `listBranches`: `for-each-ref --format=%(refname:short)` of local and remote branches. */
export async function branchNameLines(repository: Repository, root: string): Promise<Buffer> {
  const patterns = ["refs/heads", "refs/remotes"] as const;
  const args = ["for-each-ref", "--count=1001", "--format=%(refname:short)", ...patterns];
  const typescript = async () =>
    (await repository.cli.call(root, args, { captureBytes: branchNamesBytes })).stdout;
  if (!gitPartOn(part)) return typescript();
  return run(
    repository,
    "branches",
    injected(repository),
    args,
    (token, settle) => gitAddon().gitRefsBranchNames(token, root, [...patterns], 1001, settle),
    typescript,
    (reply) => {
      const accepted = listingReply(reply);
      // Git's capture keeps the first 1 MiB and the caller parses what fits.
      if ("data" in accepted && accepted.data.length > branchNamesBytes)
        return { data: accepted.data.subarray(0, branchNamesBytes) };
      return accepted;
    },
  );
}

/** `Repository.commit`: `rev-parse --verify <ref>^{commit}`, then the unborn check. */
export async function resolveCommitRef(
  repository: Repository,
  root: string,
  ref: string,
  signal?: AbortSignal,
  directoryFd?: number,
): Promise<CommitKind> {
  const args = ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`];
  const typescript = async (): Promise<CommitKind> => {
    const result = await repository.cli.call(root, args, {
      allowFailure: true,
      directoryFd,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode === 0) return { kind: "commit", id: textOutput(result) };
    // Only HEAD has an unborn state; any other missing ref is a bad ref.
    if (ref !== "HEAD") return { kind: "missing" };
    const symbolic = await repository.cli.call(root, ["symbolic-ref", "--quiet", "HEAD"], {
      allowFailure: true,
      directoryFd,
    });
    return symbolic.exitCode === 0 ? { kind: "unborn" } : { kind: "missing" };
  };
  if (!gitPartOn(part)) return typescript();
  const ineligible =
    injected(repository) ?? (directoryFd === undefined ? undefined : "directory_fd");
  return run(
    repository,
    "resolveCommit",
    ineligible,
    args,
    (token, settle) => gitAddon().gitRefsCommit(token, root, ref, settle),
    typescript,
    (reply) => valueReply<CommitKind>(reply),
    signal,
  );
}

/** `branchHead`'s ref lookup: the commit a local or remote-tracking branch points at. */
export async function branchCommit(
  repository: Repository,
  root: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
  const typescript = async () => {
    const result = await repository.cli.call(root, args, {
      allowFailure: true,
      ...(signal ? { signal } : {}),
    });
    return result.exitCode === 0 ? textOutput(result) : undefined;
  };
  if (!gitPartOn(part)) return typescript();
  return run(
    repository,
    "branchHead",
    injected(repository),
    args,
    (token, settle) => gitAddon().gitRefsBranchHead(token, root, ref, settle),
    typescript,
    (reply) => {
      const accepted = valueReply<string | null>(reply);
      return "data" in accepted ? { data: accepted.data ?? undefined } : accepted;
    },
    signal,
  );
}
