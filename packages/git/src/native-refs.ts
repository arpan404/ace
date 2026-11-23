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
 */
import { Buffer } from "node:buffer";
import {
  gitCrossSelected,
  gitPartOn,
  type GitPart,
  type NativeBackend,
} from "@ace/provider-kit/native-switches";
import { textOutput } from "./cli.ts";
import { countGitFallback, gitAddon, recordGitOp, throwGitError } from "./native-common.ts";
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
  op: RefsOp;
  selected: NativeBackend;
  completed: NativeBackend;
  fallback?: string;
}

function record({ op, selected, completed, fallback }: Logged): void {
  recordGitOp({ op, part, selected, completed, ...(fallback === undefined ? {} : { fallback }) });
}

function fallbackReason(fallback: string, op: RefsOp, selected: NativeBackend): void {
  record({ op, selected, completed: "typescript", fallback });
  countGitFallback(fallback);
}

/**
 * Runs one ref process: native when the part is on and this call may use it, the same Git
 * command otherwise. `ineligible` names why a native selection may not run, and is recorded
 * as its fallback; `accept` reads the addon's reply and names the fallback it asked for.
 */
async function run<T>(
  op: RefsOp,
  ineligible: string | undefined,
  attempt: () => Buffer | string,
  typescript: () => Promise<T>,
  accept: (reply: Buffer | string) => { data: T } | { fallback: string },
): Promise<T> {
  const selected: NativeBackend = gitCrossSelected() ?? "native";
  if (selected === "typescript") {
    record({ op, selected, completed: "typescript" });
    return typescript();
  }
  if (ineligible !== undefined) {
    fallbackReason(ineligible, op, selected);
    return typescript();
  }
  let accepted: { data: T } | { fallback: string };
  try {
    accepted = accept(attempt());
  } catch (error) {
    record({ op, selected, completed: "native" });
    throwGitError(error);
  }
  if ("fallback" in accepted) {
    fallbackReason(accepted.fallback, op, selected);
    return typescript();
  }
  record({ op, selected, completed: "native" });
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
function listingReply(reply: Buffer | string): { data: Buffer } | { fallback: string } {
  if (typeof reply === "string") {
    const fallback = fallbackOf(JSON.parse(reply));
    if (fallback === undefined)
      throw new GitError("git_failed", "ace-git refs reply is not a listing");
    return { fallback };
  }
  return { data: Buffer.from(reply) };
}

/** One `ace-json` value, or the reason the CLI has to answer instead. */
function valueReply<T>(reply: Buffer | string): { data: T } | { fallback: string } {
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
  const typescript = async () =>
    (
      await repository.cli.call(
        repo,
        ["worktree", "list", "--porcelain", "-z"],
        signal ? { signal } : {},
      )
    ).stdout;
  if (!gitPartOn(part)) return typescript();
  return run(
    "listWorktrees",
    injected(repository),
    () => gitAddon().gitRefsWorktrees(repo),
    typescript,
    listingReply,
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
    "branchRefs",
    injected(repository),
    () => gitAddon().gitRefsBranchListing(root, [...patterns], count),
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
  const typescript = async () =>
    (
      await repository.cli.call(
        root,
        ["for-each-ref", "--count=1001", "--format=%(refname:short)", ...patterns],
        { captureBytes: branchNamesBytes },
      )
    ).stdout;
  if (!gitPartOn(part)) return typescript();
  return run(
    "branches",
    injected(repository),
    () => gitAddon().gitRefsBranchNames(root, [...patterns], 1001),
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
  const typescript = async (): Promise<CommitKind> => {
    const result = await repository.cli.call(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { allowFailure: true, directoryFd, ...(signal ? { signal } : {}) },
    );
    if (result.exitCode === 0) return { kind: "commit", id: textOutput(result) };
    const symbolic = await repository.cli.call(root, ["symbolic-ref", "--quiet", "HEAD"], {
      allowFailure: true,
      directoryFd,
    });
    return ref === "HEAD" && symbolic.exitCode === 0 ? { kind: "unborn" } : { kind: "missing" };
  };
  if (!gitPartOn(part)) return typescript();
  const ineligible =
    injected(repository) ?? (directoryFd === undefined ? undefined : "directory_fd");
  return run(
    "resolveCommit",
    ineligible,
    () => gitAddon().gitRefsCommit(root, ref),
    typescript,
    (reply) => valueReply<CommitKind>(reply),
  );
}

/** `branchHead`'s ref lookup: the commit a local or remote-tracking branch points at. */
export async function branchCommit(
  repository: Repository,
  root: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const typescript = async () => {
    const result = await repository.cli.call(
      root,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      { allowFailure: true, ...(signal ? { signal } : {}) },
    );
    return result.exitCode === 0 ? textOutput(result) : undefined;
  };
  if (!gitPartOn(part)) return typescript();
  return run(
    "branchHead",
    injected(repository),
    () => gitAddon().gitRefsBranchHead(root, ref),
    typescript,
    (reply) => {
      const accepted = valueReply<string | null>(reply);
      return "data" in accepted ? { data: accepted.data ?? undefined } : accepted;
    },
  );
}
