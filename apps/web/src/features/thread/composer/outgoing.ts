import type { PendingSend } from "@ace/client";
import type { StagedSend } from "./send-store.ts";

/*
 * The person's messages the daemon doesn't have yet, and those that didn't go: each stays in the
 * composer's strip until the daemon takes it (its receipt), or the person resends, edits or
 * removes it, so nothing sent is ever out of sight. Once the daemon has a message it is the
 * daemon's to show: in the transcript, or in the queue. The transcript draws only the daemon's
 * items, so a message it already holds never comes back as a copy. Pure.
 */

/** One message on its way, or one that didn't go. */
export interface Outgoing {
  commandId: string;
  /** The outbox entry, once it was enqueued. */
  send?: PendingSend | undefined;
  /** Held for its uploads (`staged-sends.ts`): it speaks for the message while it exists. */
  staged?: StagedSend | undefined;
  /** It needs the person: it can't go as it is. */
  failed: boolean;
}

export interface OutgoingFacts {
  /** This thread's outbox entries, oldest first. */
  pending: readonly PendingSend[];
  /** Messages held for their uploads that the transcript doesn't have yet. */
  staged: readonly StagedSend[];
  /** Commands waiting in the thread's queue: the queue lists them. */
  queued: ReadonlySet<string>;
  /** Failed sends the person resent or took back to edit. */
  dismissed: ReadonlySet<string>;
  /** Commands whose message the daemon's transcript holds: the transcript says how they went. */
  admitted: ReadonlySet<string>;
}

/** Still this device's: saving to the outbox, or sent without a receipt yet. */
const inFlight = (send: PendingSend) => send.state === "saving" || send.state === "sent";

/** Messages on their way and those that didn't go, oldest first; held uploads after the outbox. */
export function outgoing(facts: OutgoingFacts): readonly Outgoing[] {
  const held = new Map(facts.staged.map((send) => [send.commandId, send]));
  const skip = (commandId: string) =>
    facts.dismissed.has(commandId) || facts.queued.has(commandId) || facts.admitted.has(commandId);
  const rows: Outgoing[] = [];
  for (const send of facts.pending) {
    if (held.has(send.commandId) || skip(send.commandId)) continue;
    if (send.state === "failed") rows.push({ commandId: send.commandId, send, failed: true });
    else if (inFlight(send)) rows.push({ commandId: send.commandId, send, failed: false });
  }
  for (const staged of facts.staged) {
    if (skip(staged.commandId)) continue;
    const send = facts.pending.find((entry) => entry.commandId === staged.commandId);
    const failed = !!staged.failed || !!staged.uploadInterrupted;
    rows.push({ commandId: staged.commandId, send, staged, failed });
  }
  return rows;
}

/**
 * A message still on its way with nothing yet worth a word: being saved, sent, or held while its
 * files upload. Most are through in a moment.
 */
export const quietlySending = (row: Outgoing): boolean => !row.failed && !row.send?.waiting;
