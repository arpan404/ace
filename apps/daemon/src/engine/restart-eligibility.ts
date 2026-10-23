import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";

/**
 * The thread has a native session to continue and its provider is not known to refuse resuming
 * one. Providers can still be registering at startup, and ACP negotiates session loading when it
 * opens: a resume that fails then leaves the thread held for the person with the failure shown,
 * like any refused continuation.
 */
export function continuesNatively(
  repo: EngineRepository,
  registry: AdapterRegistry,
  id: ThreadId,
): boolean {
  const state = repo.state(id);
  if (!state) return false;
  const carried = repo.transitions.get(id);
  if (!repo.session(id).nativeSessionId && !carried.fork && !carried.handoff) return false;
  const provider = state.config.provider;
  if (provider === "acp" || !registry.has(provider)) return true;
  try {
    return registry.get(provider, repo.backend(id)).capabilities.resume;
  } catch {
    return true;
  }
}

/**
 * Interrupted and held until someone acts: a restart or provider exit ace won't continue by
 * itself, or input a crash left uncertain. No provider session is live and no resume is in flight.
 */
export function heldInterrupted(repo: EngineRepository, id: ThreadId, live: boolean): boolean {
  if (live || !repo.state(id)) return false;
  const queue = repo.queue.get(id);
  return (
    queue.paused &&
    (queue.reason === "restart" || queue.reason === "uncertain") &&
    !repo.pending.recovering(id)
  );
}
