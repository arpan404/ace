/*
 * Pacing a subscription's replay to what one connection's link delivers.
 *
 * The outbox sends in strict order, and what it has written sits in the socket, the kernel and
 * the link (or the relay channel's 1 MiB credit window) where the daemon cannot see it. So a
 * replay sent at once puts all of itself ahead of anything produced a moment later: an approval
 * on another thread, a Stop's acknowledgement, a send's receipt. Paced, a replay is made one
 * piece at a time, and the next piece only once the client has acknowledged enough of the
 * earlier ones that what is still on its way is about `budgetMs` of the link's measured rate:
 * whatever is produced meanwhile is queued ahead of the pieces not yet made. Nothing already
 * queued moves.
 *
 * The client acknowledges each paced piece (`events.received`) as it hands it on; only a client
 * whose hello asked for it (`framing: ["paced-replay"]`) is paced, and only on a remote socket.
 * Pure but for the clock and timer it is given.
 */

/** What may be on its way, unacknowledged, measured in the link's time. */
export const budgetMs = 400;
/** Bounds on that budget in bytes, before and whatever the link's rate. */
export const budgetBounds = { first: 16 * 1024, least: 8 * 1024, most: 4 * 1024 * 1024 };
/**
 * A piece left unacknowledged this long no longer holds the next back: a client that stopped
 * acknowledging (or a link that went quiet) slows a replay, never stops it.
 */
export const ackTimeoutMs = 10_000;

/** The pacing a subscription's replay asks of its connection (`subscribe`). */
export interface ReplayGate {
  /** Bytes of events the next piece may carry; at least one event goes whatever it weighs. */
  pieceBytes(): number;
  /** Run `next` once another piece may be made; returns a cancel. */
  whenReady(next: () => void): () => void;
  /** A piece of `bytes` covering through `throughSeq` was handed to the outbox. */
  sent(subscriptionId: string, throughSeq: number, bytes: number): void;
  /** The subscription stopped: its pieces no longer hold anything back. */
  forget(subscriptionId: string): void;
}

interface Piece {
  subscriptionId: string;
  throughSeq: number;
  bytes: number;
  sentAt: number;
}

export class ReplayPacer implements ReplayGate {
  #now: () => number;
  #delay: (run: () => void, ms: number) => () => void;
  #pieces: Piece[] = [];
  #waiters: (() => void)[] = [];
  /** Bytes a millisecond the link delivered, as acknowledgements measured it. */
  #rate: number | undefined;
  #lastAck: number | undefined;
  #timeout: (() => void) | undefined;
  constructor(now: () => number, delay: (run: () => void, ms: number) => () => void) {
    this.#now = now;
    this.#delay = delay;
  }
  /** What may be unacknowledged now, in bytes. */
  budget(): number {
    if (this.#rate === undefined) return budgetBounds.first;
    return Math.min(budgetBounds.most, Math.max(budgetBounds.least, this.#rate * budgetMs));
  }
  /** Bytes sent and not yet acknowledged. */
  get unacknowledged(): number {
    return this.#pieces.reduce((total, piece) => total + piece.bytes, 0);
  }
  /** Half the budget, so one piece is on its way while the next is made. */
  pieceBytes(): number {
    return Math.max(1, Math.floor(this.budget() / 2));
  }
  #open(): boolean {
    return this.unacknowledged < this.budget();
  }
  whenReady(next: () => void): () => void {
    if (this.#open()) {
      next();
      return () => {};
    }
    this.#waiters.push(next);
    this.#arm();
    return () => {
      const index = this.#waiters.indexOf(next);
      if (index >= 0) this.#waiters.splice(index, 1);
    };
  }
  sent(subscriptionId: string, throughSeq: number, bytes: number): void {
    this.#pieces.push({ subscriptionId, throughSeq, bytes, sentAt: this.#now() });
  }
  /** The client handed on the piece of `subscriptionId` through `throughSeq`, and all before it. */
  received(subscriptionId: string, throughSeq: number): void {
    const now = this.#now();
    const done = this.#pieces.filter(
      (piece) => piece.subscriptionId === subscriptionId && piece.throughSeq <= throughSeq,
    );
    if (!done.length) return;
    this.#pieces = this.#pieces.filter((piece) => !done.includes(piece));
    for (const piece of done) {
      // Since the later of when it went and the previous acknowledgement: while pieces follow
      // one another, the gap between acknowledgements is the time the link took to carry it.
      const since = Math.max(piece.sentAt, this.#lastAck ?? piece.sentAt);
      const rate = piece.bytes / Math.max(1, now - since);
      this.#rate = this.#rate === undefined ? rate : this.#rate * 0.5 + rate * 0.5;
    }
    this.#lastAck = now;
    this.#wake();
  }
  /** A subscription stopped: its pieces no longer count. */
  forget(subscriptionId: string): void {
    this.#pieces = this.#pieces.filter((piece) => piece.subscriptionId !== subscriptionId);
    this.#wake();
  }
  #wake(): void {
    while (this.#waiters.length && this.#open()) this.#waiters.shift()?.();
    if (!this.#waiters.length) {
      this.#timeout?.();
      this.#timeout = undefined;
    } else this.#arm();
  }
  #arm(): void {
    this.#timeout ??= this.#delay(() => {
      this.#timeout = undefined;
      // Nothing came back in time: the oldest piece stops counting, and the next may go.
      this.#pieces.shift();
      this.#wake();
    }, ackTimeoutMs);
  }
}
