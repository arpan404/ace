import type { ClientMessage, EarlySubscribe, ServerMessage, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { WireEncoder } from "../wire-encoder.ts";
import type { NkSession } from "./admission.ts";

/*
 * The read subscribes an NK first message carries (ADR 0155, "Read subscribes before
 * confirmation"). Before the client confirms, only one kind is answered: a thread subscribe
 * resuming from a cursor, whose missed events are read under a limit the store enforces before
 * decoding anything (`BoundedEvents`), and only when the whole answer fits the session's
 * remaining read, event and output budgets. Its answer is only events applied early: the ones
 * an XX replay would carry, flagged `early`, never a ready, a progress or a snapshot, so the
 * client keeps the thread syncing. There is no subscription before confirmation; at
 * confirmation each subscribe is made as an ordinary one, from the cursor its early events
 * ended at (or as it came), free to answer with a replay or a snapshot. No snapshot,
 * projection or listener is acquired and no live event is kept before confirmation.
 */

/** XX sends a replay this small as is, without weighing a snapshot against it. */
export const EARLY_REPLAY_BYTES = 16 * 1024;

export type EarlyReads = {
  session: NkSession;
  store: Pick<Store, "headSeq" | "hasLiveThread" | "replaySafe" | "bounded">;
  canRead(threadId: ThreadId): boolean;
  encoder: Pick<WireEncoder, "eventBytes">;
  /** Sends a message on the unconfirmed socket. */
  send(message: ServerMessage): void;
};

/**
 * Answers what may be answered before confirmation and returns, in order, the subscribes to
 * run once the client confirms (held ones as they came, answered ones from where they ended).
 */
export function answerEarly(subscribes: EarlySubscribe[], reads: EarlyReads): ClientMessage[] {
  return subscribes.map((subscribe) => {
    const answered = answer(subscribe, reads);
    return answered === undefined
      ? { type: "subscribe", ...subscribe }
      : { type: "subscribe", ...subscribe, afterSeq: answered };
  });
}

/** The cursor the early events ended at, or undefined when none were sent. */
function answer(subscribe: EarlySubscribe, reads: EarlyReads): number | undefined {
  const { session, store } = reads;
  const { scope, afterSeq } = subscribe;
  if (scope.kind !== "thread" || afterSeq === undefined) return undefined;
  if (!reads.canRead(scope.threadId) || !store.hasLiveThread(scope.threadId)) return undefined;
  try {
    if (store.replaySafe(afterSeq) === false) return undefined;
  } catch {
    return undefined;
  }
  const head = store.headSeq();
  if (afterSeq > head) return undefined;
  const room = session.remaining();
  const read = store.bounded.threadEvents(scope.threadId, afterSeq, head, {
    rows: room.events,
    bytes: Math.min(room.bytes, EARLY_REPLAY_BYTES),
  });
  if (!read) return undefined;
  const wire = read.events.reduce((total, event) => total + reads.encoder.eventBytes(event), 0);
  if (wire > EARLY_REPLAY_BYTES) return undefined;
  // Nothing missed of this thread: nothing to send early.
  if (!read.events.length) return undefined;
  // The missed events in one frame, as an XX replay carries them, flagged early.
  const messages: ServerMessage[] = [
    {
      type: "events",
      subscriptionId: subscribe.subscriptionId,
      afterSeq,
      throughSeq: head,
      events: read.events,
      early: true,
    },
  ];
  // Its JSON is at least what goes on the wire: the answer fits the output left, or isn't sent.
  const size = messages.reduce(
    (total, message) => total + Buffer.byteLength(JSON.stringify(message)),
    0,
  );
  if (size > room.output) return undefined;
  if (!session.reserveBytes(read.bytes) || !session.reserveEvents(read.events.length))
    return undefined;
  for (const message of messages) reads.send(message);
  return head;
}
