import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import { livePending } from "./workspace-change.ts";

/**
 * Hold a checkout for one source control change (discard, switch, pull, stash). Every thread
 * bound to the checkout must be quiescent: no turn, pending input, live tool or provider
 * background work. While `effect` runs each of them is guarded, so no send is admitted and no
 * queued intent dispatches; afterwards the guards lift and the threads wake. Unlike a workspace
 * change it closes no session and moves no binding: the files change, the root does not.
 */
export async function holdCheckout<T>(
  repo: EngineRepository,
  id: ThreadId,
  commandId: string,
  root: string,
  wake: (id: ThreadId) => void,
  effect: () => Promise<T>,
): Promise<T> {
  const reservations = repo.store.workspaceReservations;
  const owners = [...new Set([id, ...reservations.owners([root])])];
  repo.store.atomic(() => {
    if (reservations.holds(root) || reservations.threadReserved(id))
      throw new Error("workspace_change_in_progress");
    for (const owner of owners) {
      const state = repo.state(owner);
      if (
        repo.transitions.guarded(owner) ||
        (state && !repo.quiescent(state)) ||
        livePending(repo, owner)
      )
        throw new Error("agent_working");
    }
    for (const owner of owners) repo.transitions.guard(owner, commandId);
  });
  try {
    return await effect();
  } finally {
    repo.transitions.releaseGuards(commandId);
    for (const owner of owners) if (repo.state(owner)) wake(owner);
  }
}
