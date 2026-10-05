import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

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
}

export interface GitOptions {
  processRuntime?: Partial<GitProcessRuntime>;
  gitBinary?: string;
  timeoutMs?: number;
  maxPatchBytes?: number;
  now?: () => Date | Promise<Date>;
  tempDirectory?: string;
  checkpointCounterCacheSize?: number;
}

export type GitErrorCode =
  | "git_missing"
  | "git_too_old"
  | "git_failed"
  | "head_moved"
  | "conflicts"
  | "hook_failed"
  | "auth_failed"
  | "git_timeout"
  | "git_cancelled"
  | "git_closed"
  | "git_busy"
  | "malformed_output"
  | "filesystem_error"
  | "output_too_large"
  | "not_a_repo"
  | "invalid_argument"
  | "invalid_ref"
  | "branch_exists"
  | "dirty_worktree"
  | "worktree_not_found"
  | "main_worktree"
  | "checkpoint_not_found"
  | "restore_collision"
  | "unsupported_repository";

export class GitError extends Error {
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
