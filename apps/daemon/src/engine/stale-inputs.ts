import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/**
 * An uncertain input is one ace handed to the provider without a confirmation: the send call
 * failed after submission, or the session ended or the daemon restarted before the provider
 * acknowledged it. It stays in the queue as "may have run" so the person can resend or drop it,
 * and holds the queue so later messages don't overtake that choice.
 *
 * Its moment passes on its own, and then it is retired: it leaves the queue and stops holding
 * anything, but it is never sent again (it may already have run) and its transcript notice
 * stays. Two things end that moment:
 *
 * - the provider ends a turn in the session the input was submitted to. Whatever that session
 *   did with it is done; no later run can confirm it any more.
 * - a new message arrives (from the person or a parent agent). That message is the go-ahead,
 *   the same way it carries on a stopped turn: the old input is not waited on any longer.
 */
const sends = "kind IN ('thread.send','thread.create')";

/** The provider ended a turn in session `generation`: its unconfirmed sends are settled. */
export function retireEndedTurnInputs(
  repo: EngineRepository,
  id: ThreadId,
  generation: number,
  at: number,
): void {
  const rows = repo.store
    .statement(
      `SELECT id FROM intents WHERE thread_id=? AND uncertain=1 AND ${sends} AND submitted_generation=?`,
    )
    .all(id, generation);
  if (retire(repo, rows)) releaseUncertainHold(repo, id, at);
}

/**
 * A new message is the go-ahead past every uncertain input. A Cursor SDK continuation is kept:
 * its checkpoint must be reconciled by that continuation before new input.
 */
export function retireUncertainInputs(repo: EngineRepository, id: ThreadId, at: number): void {
  const keepContinuation = repo.backend(id) === "cursor-sdk";
  const continuation = keepContinuation ? undefined : repo.pending.uncertainContinuation(id);
  const rows = repo.store
    .statement(
      keepContinuation
        ? `SELECT id FROM intents WHERE thread_id=? AND uncertain=1 AND ${sends}`
        : "SELECT id FROM intents WHERE thread_id=? AND uncertain=1",
    )
    .all(id);
  if (!retire(repo, rows)) return;
  if (continuation) {
    repo.pending.finishContinuation(id);
    repo.queue.set(id, { continuation: null, trigger: null }, at);
  }
  releaseUncertainHold(repo, id, at);
}

function retire(repo: EngineRepository, rows: Record<string, unknown>[]): boolean {
  for (const row of rows) {
    if (typeof row.id !== "number") throw new Error("Invalid intent identity");
    repo.queue.clearUncertain(row.id);
    repo.queue.prune(row.id);
  }
  return rows.length > 0;
}

/** Only the ambiguity hold is lifted; a limit, Stop or continuation hold keeps its own reason. */
function releaseUncertainHold(repo: EngineRepository, id: ThreadId, at: number): void {
  const queue = repo.queue.get(id);
  if (queue.reason !== "uncertain" || repo.queue.hasUncertain(id)) {
    // The queue still changed: bump its revision so clients drop the retired entries.
    repo.queue.set(id, {}, at);
    return;
  }
  if (queue.limited || queue.continuation) repo.queue.reconcileUncertainty(id, at);
  else repo.queue.set(id, { paused: false, reason: null }, at);
}
