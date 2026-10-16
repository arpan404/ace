import type { ThreadId } from "@ace/protocol";
import type { ThreadActor } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";

export interface SlotReclaimPorts {
  repo: EngineRepository;
  actors(): Iterable<[ThreadId, ThreadActor]>;
  closing(id: ThreadId): boolean;
  /** Runs the thread's control worker, which closes a session whose idle release is due. */
  retire(id: ThreadId): void;
}

/**
 * Frees an engine slot held only by a warm idle session: a finished thread with nothing
 * pending. The oldest such session is asked to close now instead of at its idle deadline, so
 * new work is admitted rather than refused while finished threads keep their processes warm.
 * Returns the retiring thread, whose slot no longer counts against capacity.
 */
export function reclaimIdleSlot(
  ports: SlotReclaimPorts,
  retiring: ReadonlySet<ThreadId>,
): ThreadId | undefined {
  const { repo } = ports;
  for (const [id, actor] of ports.actors()) {
    if (!actor.session || actor.idleSince === undefined || actor.idleDue) continue;
    if (retiring.has(id) || ports.closing(id) || !repo.reservedSlot(id)) continue;
    if (
      repo.sessionOpening(id) ||
      repo.pending.running(id) ||
      repo.pending.message(id) ||
      repo.pending.recovery(id) ||
      repo.pending.transition(id) ||
      repo.pending.controls(id).length
    )
      continue;
    actor.idleDue = true;
    ports.retire(id);
    return id;
  }
  return undefined;
}
