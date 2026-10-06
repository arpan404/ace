import { GitError } from "@ace/git";
import type { ThreadId, ThreadDetails } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { handoff } from "./transition-history.ts";

export interface WorkspaceChangeReservation {
  roots: readonly string[];
  hasOwnedWork(id: ThreadId): boolean;
  /** Binding-only changes select one thread; Git changes fence every owner of the roots. */
  threads?: readonly ThreadId[];
}

/** Persist a fence before closing a session or mutating Git. A restart retains the fence until explicit retry. */
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
              },
            },
          },
        },
      ],
      now(),
    );
  const roots = repo.store.workspaceReservations.roots(id, reservation.roots);
  const rootOwners = repo.store.workspaceReservations.owners(roots);
  const owners = [...new Set([id, ...(reservation.threads ?? rootOwners)])];
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
        context: [],
      });
      status("applied", details);
      commit();
      repo.store.workspaceReservations.release(commandId);
    });
  } catch (error) {
    const code =
      error instanceof GitError
        ? `git_${error.code.replace(/^git_/, "")}`
        : "workspace_change_failed";
    const uncertain = !(
      error instanceof GitError &&
      ["dirty_worktree", "conflicts", "invalid_ref", "invalid_argument"].includes(error.code)
    );
    safeToRelease = !uncertain;
    status("failed", thread.details ?? {}, code, uncertain);
    throw error;
  } finally {
    if (safeToRelease) repo.store.workspaceReservations.release(commandId);
    repo.transitions.releaseGuards(commandId);
    for (const owner of new Set([id, ...rootOwners])) wake(owner);
  }
}
