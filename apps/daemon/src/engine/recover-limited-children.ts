import { Command, type CommandResult, type ExecutionSelection, type ThreadId } from "@ace/protocol";
import type { ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";

export type RecoveryDispatch = (command: Command) => CommandResult;

/** Captured before the source closes; working and manually stopped children keep their owner. */
export function limitedChildren(repo: EngineRepository, state: ThreadState): ThreadId[] {
  return Object.values(state.agents).flatMap((record) => {
    const id = record.agent.childThreadId;
    if (!id || record.externalStatus?.state !== "limited" || !repo.store.getThread(id)) return [];
    const queue = repo.queue.get(id);
    if (repo.queue.hasUncertain(id) || repo.pending.recovering(id)) return [];
    return queue.paused && ["manual", "stopped"].includes(queue.reason ?? "") ? [] : [id];
  });
}

/** The parent's switch and these child commands commit together; receipts make replay harmless. */
export function recoverLimitedChildren(
  repo: EngineRepository,
  children: readonly ThreadId[],
  selection: ExecutionSelection,
  source: Command,
  dispatch: RecoveryDispatch,
): void {
  for (const id of new Set(children)) {
    const current = repo.store.getThread(id);
    if (!current || current.status.state !== "limited") continue;
    const base = `${source.id}:child:${id}`;
    const switched = dispatch(
      Command.parse({
        id: `${base}:switch`,
        deviceId: source.deviceId,
        payload: { type: "thread.switch", threadId: id, selection },
      }),
    );
    if (!switched.ok) throw new Error(`Could not switch limited child ${id}: ${switched.error}`);
    const sent = dispatch(
      Command.parse({
        id: `${base}:continue`,
        deviceId: source.deviceId,
        payload: {
          type: "thread.send",
          threadId: id,
          delivery: "queue",
          input: [
            {
              type: "text",
              text: "Continue your existing delegated task on the selected replacement provider. Preserve completed work and check unfinished operations before restarting them.",
            },
          ],
        },
      }),
    );
    if (!sent.ok) throw new Error(`Could not continue limited child ${id}: ${sent.error}`);
  }
}
