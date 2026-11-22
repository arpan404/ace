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
/** True when settling would send an attempted send again as never admitted. */
export function requeueNeedsProof(repo: EngineRepository, id: ThreadId): boolean {
  const admission = repo.recovery.lastAdmission(id);
  if (!admission?.commandId || admission.admitted) return false;
  return mayRequeue(repo, id, admission.commandId);
}
/** True when an attempted send, read back as never admitted, would be sent again. */
export function mayRequeue(repo: EngineRepository, id: ThreadId, commandId: string): boolean {
  if (!repo.pending.uncertainSend(id, commandId)) return false;
  return !repo.recovery.admissionRecorded(id, commandId);
}

/**
 * The held sends whose fate a reopen couldn't read: the attempted one, or, for an earlier build's
 * thread whose attempt is past the frames it kept (no command id), every send held as uncertain.
 */
export function inDoubt(repo: EngineRepository, id: ThreadId) {
  const command = repo.recovery.attemptedCommand(id);
  if (command) {
    const intent = repo.pending.uncertainSend(id, command);
    return intent ? [intent] : [];
  }
  return repo.recovery.unknownAttempt(id) ? repo.pending.uncertainSends(id) : [];
}

export function settleCursorAttempt(
  repo: EngineRepository,
  id: ThreadId,
  at: number,
  /** The previous run's process groups are proven gone: an empty read of the store is final. */
  verified: boolean,
): void {
  const admission = repo.recovery.lastAdmission(id);
  if (!admission?.commandId) {
    // The host read nothing back of the attempt (an earlier build's search gave up): its fate
    // is unknown, and the thread says that, not the restart's "not sent".
    const waiting = inDoubt(repo, id);
    if (!waiting.length) return;
    for (const intent of waiting) unconfirmed(repo, id, intent.id, at);
    // Nothing more will come of the attempt: the thread waits on the person, not on Cursor.
    const root = repo.requireState(id).rootKey ?? "root";
    repo.apply(id, [{ type: "wake.expected", agent: root, until: at }], at);
    return;
  }
  const intent = repo.pending.uncertainSend(id, admission.commandId);
  if (!intent) return;
  if (admission.admitted) acknowledge(repo, id, intent.id, admission.commandId, at);
  // Unverified, a dying host may still be creating the run: the send stays uncertain.
  else if (verified && !repo.recovery.admissionRecorded(id, admission.commandId)) {
    repo.queue.clearUncertain(intent.id);
    repo.pending.defer(intent);
    repo.queue.track(intent.id, id, intent.command);
    say(repo, id, intent.id, at, requeuedNotice);
  } else {
    unconfirmed(repo, id, intent.id, at);
    return;
  }
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

/** A message queued to send again, its notice waiting for Cursor's acknowledgement. */
export const resendingCode = "delivery_resending";
/** What a re-queued message's notice becomes once its new delivery is acknowledged. */
export const resentNotice = {
  code: "delivery_confirmed",
  level: "info",
  title: "Sent again",
  text: "ace restarted before Cursor received this message, so it was sent again",
} as const;
type Notice = { code: string; level: "info" | "warning"; title: string; text: string };
/**
 * Proven never to have reached Cursor, and back in the queue: the only case ace says it wasn't
 * sent. It says "Sent again" (`resentNotice`) only once Cursor acknowledges the new delivery.
 */
const requeuedNotice: Notice = {
  code: resendingCode,
  level: "info",
  title: "Queued to send again",
  text: "ace restarted before Cursor received this message, so it is queued to send again",
};
const unconfirmedNotice: Notice = {
  code: "delivery_uncertain",
  level: "warning",
  title: "Delivery unconfirmed",
  text: "ace couldn't confirm whether Cursor received this message. It is held in the queue: check the conversation before sending it again",
};
/**
 * The send's fate couldn't be settled: whether Cursor had it is unknown, and the thread says
 * that, never that it wasn't sent (a resend by hand could then be a second copy).
 */
export function unconfirmed(repo: EngineRepository, id: ThreadId, intentId: number, at: number) {
  say(repo, id, intentId, at, unconfirmedNotice);
}
function say(repo: EngineRepository, id: ThreadId, intentId: number, at: number, notice: Notice) {
  const state = repo.requireState(id);
  const before = state.items[`intent:${intentId}`];
  repo.apply(
    id,
    [
      {
        type: "item.upsert",
        agent: state.rootKey ?? "root",
        item: `intent:${intentId}`,
        draft: {
          type: "notice",
          ...notice,
          ...(before?.type === "notice" && before.commandId ? { commandId: before.commandId } : {}),
          complete: true,
        },
      },
    ],
    at,
  );
}
