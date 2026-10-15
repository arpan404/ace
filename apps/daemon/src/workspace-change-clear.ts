import { isMutationUnavailable, type GitService } from "@ace/git";
import type { CommandResult, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";
import { exists } from "./workspace-move.ts";

type MutationGit = Pick<GitService, "assertMutationAvailable">;

/** Whether Git reports every root the thread's change fenced free of unfinished writers. */
async function fencedRootsFree(store: Store, git: MutationGit, id: ThreadId): Promise<boolean> {
  for (const root of store.workspaceReservations.threadRoots(id)) {
    // A root that no longer exists has no writer left.
    if (!(await exists(root))) continue;
    try {
      await git.assertMutationAvailable(root);
    } catch (error) {
      if (isMutationUnavailable(error)) return false;
      throw error;
    }
  }
  return true;
}

/**
 * Clear a failed checkout move after the person confirms. Its fence goes only once Git reports
 * every fenced root free of unfinished writers; a root that no longer exists has none.
 */
export async function clearWorkspaceChange(
  store: Store,
  git: MutationGit,
  id: ThreadId,
  now: () => number,
): Promise<Omit<CommandResult, "commandId">> {
  const thread = store.getThread(id);
  if (!thread || thread.deletedAt !== undefined) return { ok: false, error: "thread_not_found" };
  if (thread.details?.workspaceChange?.state !== "failed")
    return { ok: false, error: "workspace_change_in_progress" };
  if (!(await fencedRootsFree(store, git, id))) return { ok: false, error: "git_quarantined" };
  store.atomic(() => {
    store.workspaceReservations.releaseThread(id);
    const current = store.getThread(id);
    if (!current?.details) return;
    const { workspaceChange: _cleared, ...details } = current.details;
    store.appendEvents(id, [{ type: "thread.client.updated", changes: { details } }], now());
  });
  return { ok: true, threadId: id };
}

/**
 * Settle a checkout move nothing is running any more: one a restart interrupted while it was
 * preparing, or one whose failure left its outcome uncertain. Once Git reports every fenced
 * root free, the fence goes and the move is recorded as a plain failure. The binding was never
 * switched (that happens only with success), so the thread works again where it was, and Retry
 * asks for the same move. A thread the engine still guards, or `running` reports, is left
 * alone: its change is in flight. Returns whether the move was settled.
 */
export async function settleWorkspaceChange(
  store: Store,
  git: MutationGit,
  id: ThreadId,
  now: () => number,
  running: (id: ThreadId) => boolean,
): Promise<boolean> {
  const change = store.getThread(id)?.details?.workspaceChange;
  const stuck = (state: typeof change) =>
    state !== undefined && (state.state === "preparing" || state.uncertain === true);
  const reservations = store.workspaceReservations;
  const busy = () => running(id) || reservations.transitionGuarded(id);
  const fenced = reservations.threadRoots(id).length > 0;
  if (busy() || (!stuck(change) && !fenced)) return false;
  if (!(await fencedRootsFree(store, git, id))) return false;
  return store.atomic(() => {
    const thread = store.getThread(id);
    const current = thread?.details?.workspaceChange;
    // A change that started while Git was being asked owns the marker and the fence now.
    if (busy() || current?.commandId !== change?.commandId) return false;
    reservations.releaseThread(id);
    if (!thread || !current || !stuck(current)) return true;
    store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: {
            details: {
              ...thread.details,
              workspaceChange: {
                ...current,
                state: "failed",
                uncertain: false,
                at: now(),
                error:
                  current.state === "preparing"
                    ? "workspace_change_interrupted"
                    : (current.error ?? "workspace_change_failed"),
              },
            },
          },
        },
      ],
      now(),
    );
    return true;
  });
}
