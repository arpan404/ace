import type {
  CleanupReceipt,
  MutationCleanupSupervisor,
  MutationLease,
} from "@ace/provider-kit/cleanup";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

/** A durable mutation intent ace retired, and why: for the host's log. */
export interface RetiredLease {
  lease: MutationLease;
  /** The repository's main checkout, or the lease's root for a standalone journal. */
  repository: string;
  /**
   * Automatic: `owner_gone_roots_settled` (its daemon stopped and its checkouts are gone),
   * `owner_gone_processes_gone` (its daemon stopped and no Git process runs in its checkouts),
   * `own_processes_gone` (this daemon killed its Git process and that process group is gone),
   * `own_lease_processes_gone` (this daemon wrote it, lost track of it, and no Git process runs
   * in its checkouts). `confirmed_stale`: a person chose Clear stale lock.
   */
  reason:
    | "owner_gone_roots_settled"
    | "owner_gone_processes_gone"
    | "own_processes_gone"
    | "own_lease_processes_gone"
    | "confirmed_stale";
}

export interface GitProcessRuntime {
  spawn: (
    command: string,
    args: string[],
    options: Omit<SpawnOptionsWithoutStdio, "stdio"> & {
      stdio: ["pipe", "pipe", "pipe", ...number[]];
    },
  ) => ChildProcessWithoutNullStreams;
  scheduleTimeout: (callback: () => void, milliseconds: number) => () => void;
  platform: NodeJS.Platform;
  signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether any process of the POSIX process group led by `pid` is alive. */
  groupAlive: (pid: number) => boolean;
  /** Every live Git process and its working directory; `undefined` when it can't be listed. */
  gitProcesses: () => Promise<readonly { pid: number; cwd?: string | undefined }[] | undefined>;
  cleanupSupervisor?: MutationCleanupSupervisor<ChildProcessWithoutNullStreams>;
}

export interface GitOptions {
  /** Host admission owns the whole discovery/execution lifetime across linked worktrees. */
  withRepositoryTransfer?: <T>(repository: string, operation: () => Promise<T>) => Promise<T>;
  /** Reads helper names only from the user's system/global files, never repository config. */
  credentialHelperLookup?: GitCredentialHelperLookup;
  /** Daemon-owned config paths. Global files are read in XDG, then home order. */
  credentialConfigPaths?: { system?: string; xdg?: string; global?: string };
  /** Tests may inject file transport for local remotes; production uses http/https/ssh. */
  transportProtocols?: readonly ("http" | "https" | "ssh" | "file")[];
  leaseId?: () => string;
  /** Hears each stale mutation lease ace retires, automatically or on "Clear stale lock". */
  onLeaseRetired?: (event: RetiredLease) => void;
  processRuntime?: Partial<GitProcessRuntime>;
  gitBinary?: string;
  timeoutMs?: number;
  /**
   * How long a Git change waits for a lease that clears on its own (another daemon finishing, a
   * stopped process ending) before it reports the lock. Default 60 seconds.
   */
  leaseWaitMs?: number;
  maxPatchBytes?: number;
  now?: () => Date | Promise<Date>;
  tempDirectory?: string;
  /** Per-service LRU entry limit across all root/thread pairs, 1..4096; default 128. */
  checkpointCounterCacheSize?: number;
}

export type GitCredentialScope = "system" | "global";
export interface GitCredentialHelper {
  key: string;
  value: string;
}
export type GitCredentialHelperLookup = (
  scope: GitCredentialScope,
  signal?: AbortSignal,
) => Promise<readonly GitCredentialHelper[]>;

export type GitErrorCode =
  | "repository_agent_running"
  | "sensitive_publication"
  | "publication_scan_incomplete"
  | "git_missing"
  | "git_too_old"
  | "git_failed"
  | "objects_not_available"
  | "head_moved"
  | "conflicts"
  | "hook_failed"
  | "auth_failed"
  | "remote_unreachable"
  | "remote_ref_not_found"
  | "git_timeout"
  | "git_cancelled"
  | "git_closed"
  | "git_busy"
  | "git_quarantined"
  | "malformed_output"
  | "filesystem_error"
  | "output_too_large"
  | "not_a_repo"
  | "invalid_argument"
  | "invalid_ref"
  | "pr_base_mismatch"
  | "branch_exists"
  | "dirty_worktree"
  | "worktree_not_found"
  | "main_worktree"
  | "checkpoint_not_found"
  | "restore_collision"
  | "unsupported_repository"
  | GitFailureCode;

/**
 * Failed Git commands whose stderr names one cause. Each is a stable public code; the
 * failure's `details.stderr` keeps a bounded, redacted tail of what Git said.
 */
export const gitFailureCodes = [
  /** The branch is already checked out in another worktree. */
  "branch_checked_out",
  /** The destination path of a new worktree already exists. */
  "path_exists",
  /** A ref name collides with an existing one, e.g. branch `ace` versus `ace/<hex>`. */
  "ref_conflict",
  /** The repository has no commits yet: HEAD names an unborn branch. */
  "unborn_head",
  /** No author/committer name or email is configured. */
  "identity_missing",
  /** A commit was asked for, but nothing changed. */
  "nothing_to_commit",
  /** The remote refused a non-fast-forward update; fetch and integrate first. */
  "push_rejected",
  /** The remote refused the update because the branch is protected. */
  "protected_branch",
] as const;
export type GitFailureCode = (typeof gitFailureCodes)[number];

export class GitError extends Error {
  cleanup?: CleanupReceipt | undefined;
  readonly code: GitErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: GitErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.details = details;
  }
}

export interface StatusEntry {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  submodule: string;
}

export function toGitError(error: unknown): GitError {
  if (error instanceof GitError) return error;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return new GitError("filesystem_error", error.message, { errno: error.code });
  }
  return new GitError("git_failed", error instanceof Error ? error.message : String(error));
}

export interface Status {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  conflicted: StatusEntry[];
}

export interface RepositoryInfo {
  root: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remotes: { name: string; fetchUrls: string[]; pushUrls: string[] }[];
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
}

export interface Checkpoint {
  id: string;
  sha: string;
  tree: string;
  threadId: string;
  sequence: number;
  label: string;
  createdAt: string;
}

/** Selected immutable file lines, with EOF facts for review admission. */
export interface RevisionLines {
  lines: string[];
  atEof: boolean;
  noFinalNewline: boolean;
}

export type DiffSide =
  | { kind: "working-tree" }
  | { kind: "commit"; ref: string }
  | { kind: "checkpoint"; id: string };

export interface DiffEntry {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffResult {
  entries: DiffEntry[];
  patch: string;
  truncated: boolean;
}

/** One file `git status` reports, with its lines changed against HEAD. */
export interface ChangedFile {
  path: string;
  /** A rename's old path. */
  from?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary: boolean;
}

/** A bounded failure can outlive its supervised mutation ownership. */
export function isMutationUnavailable(error: unknown): boolean {
  return (
    error instanceof GitError && (error.code === "git_quarantined" || error.cleanup !== undefined)
  );
}

export type PushOptions = {
  worktree: string;
  remote: string;
  beforePush?: () => void;
  expected?: { branch: string; head: string | null; pushUrls: readonly string[] };
};
