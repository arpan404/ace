import { isMutationUnavailable, type GitService } from "@ace/git";
import type { CommandResult, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";
import { exists } from "./workspace-move.ts";

/**
 * Clear a failed checkout move after the person confirms. Its fence goes only once Git reports
 * every fenced root free of unfinished writers; a root that no longer exists has none.
 */
export async function clearWorkspaceChange(
  store: Store,
  git: Pick<GitService, "assertMutationAvailable">,
  id: ThreadId,
  now: () => number,
): Promise<Omit<CommandResult, "commandId">> {
  const thread = store.getThread(id);
  if (!thread || thread.deletedAt !== undefined) return { ok: false, error: "thread_not_found" };
  if (thread.details?.workspaceChange?.state !== "failed")
    return { ok: false, error: "workspace_change_in_progress" };
  for (const root of store.workspaceReservations.threadRoots(id)) {
    if (!(await exists(root))) continue;
    try {
      await git.assertMutationAvailable(root);
    } catch (error) {
      if (isMutationUnavailable(error)) return { ok: false, error: "git_quarantined" };
      throw error;
    }
  }
  store.atomic(() => {
    store.workspaceReservations.releaseThread(id);
    const current = store.getThread(id);
    if (!current?.details) return;
    const { workspaceChange: _cleared, ...details } = current.details;
    store.appendEvents(id, [{ type: "thread.client.updated", changes: { details } }], now());
  });
  return { ok: true, threadId: id };
}
