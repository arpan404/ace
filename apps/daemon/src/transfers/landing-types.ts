import type { ProjectGitPolicy } from "@ace/git";
import type { PinnedDirectory } from "@ace/workspace";
import type { IncomingTransfer, ThreadId, TransferCommit, WorkspaceId } from "@ace/protocol";
import type { TransferArchive, TransferGit } from "./ports.ts";

/**
 * A folder new projects may be made in, validated against the allowed roots and held open, so
 * the folder a transfer makes there, and everything written into it, stays there (ADR 0063).
 */
export interface TransferParent {
  path: string;
  handle: PinnedDirectory;
  close(): Promise<void>;
}

/** The target's projects, through the owner that registers them (ADR 0063). */
export interface TargetProjects {
  /** Registered projects with their folders. */
  list(): { workspaceId: WorkspaceId; path: string }[];
  /**
   * Whether something on this machine is working in the project's own checkout right now: a
   * local thread that hasn't settled, or a shell a thread opened there. A busy checkout is never
   * moved or written into; the work lands on a branch of its own instead.
   */
  busy(workspaceId: WorkspaceId): boolean;
  /** A folder inside the allowed roots for new projects, held open; omitted: the default. */
  parent(requested: string | undefined): Promise<TransferParent>;
  /**
   * `workspace.clone`, keyed so a retry runs once. `made` hears the new folder's identity as
   * soon as the clone makes it, before anything is written in it.
   */
  clone(input: {
    key: string;
    parent: string;
    name: string;
    url: string;
    signal: AbortSignal;
    made(directory: { dev: number; ino: number }): void;
  }): Promise<WorkspaceId>;
  /** `workspace.add` of a folder this transfer made. */
  register(input: { key: string; path: string; name: string }): Promise<WorkspaceId>;
  /** `workspace.remove`; the folder stays for the caller to remove. */
  unregister(workspaceId: WorkspaceId): Promise<void>;
}

export interface ContinuedThread {
  deviceId: string;
  workspaceId: WorkspaceId;
  /** The checkout for a local thread; for a worktree thread, the branch it starts from. */
  mode: "local" | "worktree";
  base?: string | undefined;
  thread: NonNullable<TransferCommit["thread"]>;
  machine: { hostId: string; name: string };
}

/** The continued thread there, made and then set up as two recoverable steps. */
export interface TargetThreadStarter {
  /**
   * Makes the thread with `thread.prepare`, without a turn. `prepare` runs in a worktree
   * thread's folder first. `cutoff` runs right before the thread is made and throws when the
   * transfer was cancelled, so a thread exists only for a transfer that can no longer be
   * cancelled. `made` runs inside the store transaction that makes the thread, so the thread and
   * the transfer's record of it commit together. The same key returns the same thread.
   */
  create(
    input: ContinuedThread & {
      key: string;
      prepare?: ((path: string) => Promise<void>) | undefined;
      cutoff(): void;
      made(threadId: ThreadId): void;
    },
  ): Promise<ThreadId>;
  /**
   * Gives a made thread its handoff and its link to the source thread, and runs `then` in the
   * same store transaction. A thread that already has them is left as it is, so a restart can
   * run this again; a thread that is gone just runs `then`.
   */
  setUp(
    input: {
      threadId: ThreadId;
      thread: NonNullable<TransferCommit["thread"]>;
      machine: { hostId: string; name: string };
    },
    then: () => void,
  ): void;
}

export interface LandingDeps {
  git: TransferGit;
  gitPolicy?: ProjectGitPolicy | undefined;
  archive: TransferArchive;
  projects: TargetProjects;
  threads: TargetThreadStarter;
  /** Folders other transfers are filling right now. */
  held: Set<string>;
  /**
   * Records what this transfer made, durably: a folder's path before it is made, and its
   * identity (`createdId`, `dev:ino`) once it is; cleared once removed.
   */
  made(change: {
    createdPath?: string | undefined;
    createdId?: string | undefined;
    registeredId?: string | undefined;
  }): void;
  /** Distinct per attempt, so a retried import never reuses an earlier attempt's receipt. */
  attempt: string;
  /**
   * Runs in the final checkout once the branch and changes are there (ignored files): the
   * folder this transfer made, held open, or the path of one it didn't make.
   */
  landed?:
    | ((destination: string | PinnedDirectory, signal: AbortSignal) => Promise<void>)
    | undefined;
  /**
   * The point after which the transfer can't be cancelled: right before the thread is made, or,
   * without a thread, once everything has landed. Synchronous; throws when it was cancelled.
   */
  cutoff(): void;
  /**
   * Records the result durably, right after the cutoff is passed; with a thread, in the same
   * store transaction that makes it.
   */
  created(result: Landed): void;
}

/** The remote method needs origin's history there; asking for a full bundle instead. */
export class NeedsFullBundle extends Error {}

export type Landed = NonNullable<IncomingTransfer["result"]>;

/** Where a sender pins a detached HEAD, so its bundle carries that commit. */
export const headRef = (transferId: string) => `refs/ace/transfer-head/${transferId}`;

/** Where the landing fetches the branch's commit from a bundle. */
export const incomingRef = (transferId: string) => `refs/ace/incoming/${transferId}`;
