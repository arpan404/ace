import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/*
 * A Cursor send the daemon saw attempted but never saw admitted is settled from what the
 * reopened host read back from Cursor's store (ADR 0043, amendment of 2026-11-22). Runs in one
 * transaction after every Cursor open, once the open has stored its own transition state.
 *
 * - Cursor has a run for it: the input is Cursor's. It is acknowledged, its delivery notice says
 *   so, and a waiting handoff it carried is cleared, as a run start would have done had the
 *   open not been suppressing acknowledgements.
 * - Cursor has none, and ace recorded nothing of it but the attempt: it never reached Cursor,
 *   so it goes back in the queue and is sent once.
 */
export function settleCursorAttempt(
  repo: EngineRepository,
  id: ThreadId,
  at: number,
  /** Startup proved the previous run's processes gone: an empty read of the store is final. */
  verified: boolean,
): void {
  const admission = repo.recovery.lastAdmission(id);
  if (!admission?.commandId) return;
  const intent = repo.pending.uncertainSend(id, admission.commandId);
  if (!intent) return;
  if (admission.admitted) acknowledge(repo, id, intent.id, admission.commandId, at);
  // Unverified, a dying host may still be creating the run: the send stays uncertain.
  else if (verified && !repo.recovery.admissionRecorded(id, admission.commandId)) {
    repo.queue.clearUncertain(intent.id);
    repo.pending.defer(intent);
    repo.queue.track(intent.id, id, intent.command);
  } else return;
  repo.queue.reconcileUncertainty(id, at);
  const queue = repo.queue.get(id);
  // Held only for this send's uncertainty: nothing else waits on the person.
  if (queue.paused && !queue.continuation && !queue.limited && queue.reason === "manual")
    repo.queue.set(id, { paused: false, reason: null }, at);
}

function acknowledge(
  repo: EngineRepository,
  id: ThreadId,
  intentId: number,
  commandId: string,
  at: number,
): void {
  const rows = repo.acknowledgeCommand(id, commandId);
  for (const row of rows) repo.queue.prune(row);
  if (!rows.includes(intentId)) return;
  repo.transitions.delivered(id);
  const state = repo.requireState(id);
  const notice = state.items[`intent:${intentId}`];
  if (notice?.type === "notice" && notice.code === "delivery_uncertain")
    repo.apply(
      id,
      [
        {
          type: "item.upsert",
          agent: state.rootKey ?? "root",
          item: `intent:${intentId}`,
          draft: {
            type: "notice",
            level: "info",
            code: "delivery_confirmed",
            title: "Message received",
            text: "Cursor had this message before ace restarted",
            complete: true,
          },
        },
      ],
      at,
    );
}
