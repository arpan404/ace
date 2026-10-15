import { GitError } from "@ace/git";
import type { ThreadId, ThreadDetails } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { handoff } from "./transition-history.ts";

export interface WorkspaceChangeReservation {
  /** Roots fenced while the change runs: no new work starts in them until it settles. */
  roots: readonly string[];
  /**
   * Roots whose checked-out files the change may rewrite (a branch switch, a remade worktree);
   * `roots` when absent. Every thread bound to one of these must be quiet, because its files
   * would change under it. A change that only rebinds the thread writes none, so threads
   * elsewhere in the project keep working.
   */
  writes?: readonly string[];
  /** A thread's own open terminal (or one sharing a written root) holds the checkout. */
  hasOwnedWork(id: ThreadId): boolean;
  /** The checkout selection asked for, recorded so a failed change can be retried. */
  selection?: { mode: "local" | "worktree"; branch?: string | undefined };
}

/** The change was refused before any Git write: its fence can be released at once. */
export class WorkspaceChangeRefused extends Error {
  readonly code: string;
  constructor(code: string, options?: { cause?: unknown }) {
    super(code, options);
    this.code = code;
  }
}
/** Refusals Git reports before it writes anything. */
const refusedGit = new Set([
  "dirty_worktree",
  "conflicts",
  "invalid_ref",
  "invalid_argument",
  "branch_checked_out",
  "path_exists",
  "ref_conflict",
  "unborn_head",
]);
const failureCode = (error: unknown) =>
  error instanceof WorkspaceChangeRefused
    ? error.code
    : error instanceof GitError
      ? `git_${error.code.replace(/^git_/, "")}`
      : "workspace_change_failed";

/**
 * Persist a fence before closing a session or mutating Git. Only the moving thread and the
 * threads bound to a root the change rewrites must be quiet. A fence an uncertain failure
 * or a restart leaves behind is settled by `settleWorkspaceChange` once Git is free.
 */
export async function changeEngineWorkspace(
  repo: EngineRepository,
  id: ThreadId,
  commandId: string,
  now: () => number,
  closeSession: (id: ThreadId) => Promise<void>,
  effect: () => Promise<ThreadDetails>,
  wake: (id: ThreadId) => void,
  reservation: WorkspaceChangeReservation,
  commit: () => void = () => {},
): Promise<void> {
  const state = repo.requireState(id);
  const thread = repo.store.getThread(id);
  if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
  if (
    repo.transitions.guarded(id) ||
    !repo.quiescent(state) ||
    !repo.pending.headers(id)[Symbol.iterator]().next().done
  )
    throw new Error("thread_tree_is_live");
  if (
    thread.details?.workspaceChange?.state === "preparing" &&
    thread.details.workspaceChange.commandId === commandId
  )
    throw new Error("workspace_change_in_progress");
  const status = (
    phase: "preparing" | "applied" | "failed",
    details: ThreadDetails,
    error?: string,
    uncertain = false,
  ) =>
    repo.store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: {
            details: {
              ...details,
              workspaceChange: {
                commandId,
                state: phase,
                at: now(),
                lossy: true,
                uncertain,
                ...(error ? { error } : {}),
                ...(reservation.selection
                  ? {
                      mode: reservation.selection.mode,
                      ...(reservation.selection.branch
                        ? { branch: reservation.selection.branch }
                        : {}),
                    }
                  : {}),
              },
            },
          },
        },
      ],
      now(),
    );
  // Any core fact turns a never-started root into an agent starting a turn, which would make
  // the thread look live and refuse this change. Such a thread has no turn to show as waiting.
  const publishQueue = () => {
    if (repo.requireState(id).initialRoot === undefined)
      repo.apply(id, [{ type: "queue.changed", count: repo.queuedCount(id) }], now());
  };
  const reservations = repo.store.workspaceReservations;
  const roots = reservations.roots(id, reservation.roots);
  const owners = [...new Set([id, ...reservations.owners(reservation.writes ?? roots)])];
  repo.store.atomic(() => {
    for (const owner of owners) {
      const peer = repo.state(owner);
      if (reservation.hasOwnedWork(owner)) throw new Error("terminal_owned");
      if (
        repo.transitions.guarded(owner) ||
        (peer && !repo.quiescent(peer)) ||
        !repo.pending.headers(owner)[Symbol.iterator]().next().done
      )
        throw new Error("thread_tree_is_live");
    }
    repo.store.workspaceReservations.reserve(id, commandId, roots);
    for (const owner of owners) repo.transitions.guard(owner, commandId);
    status("preparing", thread.details ?? {});
    publishQueue();
  });
  let safeToRelease = false;
  try {
    for (const owner of owners) if (repo.state(owner)) await closeSession(owner);
    for (const owner of owners) {
      const peer = repo.state(owner);
      if (peer && !repo.quiescent(peer)) throw new Error("thread_tree_is_live");
    }
    const context = handoff(repo, id, repo.store.headSeq(), 16384, thread.provider);
    const details = await effect();
    if (!details.worktree) throw new Error("workspace_unavailable");
    const worktree = details.worktree;
    repo.store.atomic((db) => {
      db.prepare(
        "UPDATE engine_sessions SET cwd=?,workspace_ready=1,native_session_id=NULL WHERE thread_id=?",
      ).run(worktree, id);
      const selection = repo.transitions.get(id).selection;
      repo.transitions.set(id, {
        ...(selection ? { selection } : {}),
        handoff: context,
        context: details.pullRequestWorkspace ? [details.pullRequestWorkspace.context] : [],
      });
      status("applied", details);
      commit();
      repo.store.workspaceReservations.release(commandId);
    });
  } catch (error) {
    const code = failureCode(error);
    const uncertain = !(
      error instanceof WorkspaceChangeRefused ||
      (error instanceof GitError && refusedGit.has(error.code))
    );
    safeToRelease = !uncertain;
    status("failed", thread.details ?? {}, code, uncertain);
    throw error;
  } finally {
    if (safeToRelease) repo.store.workspaceReservations.release(commandId);
    repo.transitions.releaseGuards(commandId);
    publishQueue();
    // Threads in a fenced root were refused while it was held; wake them now it is released.
    // A thread the engine has never run (imported, or never started) has nothing to wake.
    for (const owner of new Set([id, ...reservations.owners(roots)]))
      if (repo.state(owner)) wake(owner);
  }
}
