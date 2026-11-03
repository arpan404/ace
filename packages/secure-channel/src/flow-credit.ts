/**
 * Credit-based flow control for a relayed stream (ADR 0110). A relay may hold every byte a fast
 * sender writes for a slow reader (a Durable Object cannot pause a socket), so the two ends
 * limit themselves: each sends at most `FLOW_WINDOW` cost units its peer has not yet consumed.
 *
 * Wire: a credit is one encrypted fragment whose plaintext is the flag `CREDIT_FLAG` and a
 * 4-byte big-endian count of the peer's cost units consumed since the last credit. A side's
 * first credit also says "my data from here on is flow controlled", so the peer counts only
 * what follows it. Only a peer that asked (`hello.flowControl` has `credit`) is ever sent one.
 *
 * Pure accounting; the channels own the sockets, the cipher and the waiting.
 */
export const CREDIT_FLAG = 7;
/** Unconsumed cost units a side may have in flight towards its peer. */
export const FLOW_WINDOW = 1024 * 1024;
/**
 * A fragment costs its plaintext length, at least 4 KiB, so a window also bounds the fragment
 * count a reader queues (256): small fragments cost a reader per frame, not only per byte.
 */
const MIN_COST = 4096;
/** Credit is returned once a quarter window is consumed, so a reader that keeps up never stalls. */
const CREDIT_STEP = FLOW_WINDOW / 4;

export function fragmentCost(plainLength: number): number {
  return Math.max(plainLength, MIN_COST);
}

export function creditFragment(amount: number): Uint8Array {
  const plain = new Uint8Array(5);
  plain[0] = CREDIT_FLAG;
  new DataView(plain.buffer).setUint32(1, amount);
  return plain;
}

/** The amount a credit fragment returns. Throws on a malformed one. */
export function readCredit(plain: Uint8Array): number {
  if (plain.length !== 5 || plain[0] !== CREDIT_FLAG) throw new Error("Invalid credit fragment");
  const amount = new DataView(plain.buffer, plain.byteOffset, 5).getUint32(1);
  if (amount > FLOW_WINDOW) throw new Error("Invalid credit fragment");
  return amount;
}

export class FlowCredit {
  #limited = false;
  #window = 0;
  #counting = false;
  /** Data fragments queued for the reader, and how many of those predate the peer's start. */
  #queued = 0;
  #uncounted = 0;
  /** Counted cost received and not yet credited back (queued, or consumed and owed). */
  #unacked = 0;
  #owed = 0;

  /** Whether this side's sends are limited (it sent its start). */
  get limited(): boolean {
    return this.#limited;
  }
  /** Whether the peer's data is counted (its start arrived): its window bounds what it sends. */
  get counting(): boolean {
    return this.#counting;
  }

  /** Limit this side's sends from now on. The start fragment to send, the first time only. */
  start(): Uint8Array | undefined {
    if (this.#limited) return undefined;
    this.#limited = true;
    this.#window = FLOW_WINDOW;
    return creditFragment(0);
  }

  /**
   * The peer returned `amount`. Its first credit starts counting what follows and turns this
   * side's limit on too; the start fragment to send back, if this side had not started.
   */
  credited(amount: number): Uint8Array | undefined {
    if (!this.#counting) {
      this.#counting = true;
      this.#uncounted = this.#queued;
    }
    const reply = this.start();
    this.#window += amount;
    return reply;
  }

  /** Whether a fragment of `cost` may be written now. */
  allows(cost: number): boolean {
    return !this.#limited || this.#window >= cost;
  }

  spend(cost: number): void {
    if (this.#limited) this.#window -= cost;
  }

  /** A data fragment arrived. False when the peer overran the window it was given. */
  received(cost: number): boolean {
    this.#queued++;
    if (!this.#counting) return true;
    this.#unacked += cost;
    return this.#unacked <= FLOW_WINDOW;
  }

  /** The reader took a data fragment. A credit fragment to send, once enough is owed. */
  consumed(cost: number): Uint8Array | undefined {
    this.#queued--;
    if (this.#uncounted > 0) {
      this.#uncounted--;
      return undefined;
    }
    if (!this.#counting) return undefined;
    this.#owed += cost;
    if (this.#owed < CREDIT_STEP) return undefined;
    const credit = creditFragment(this.#owed);
    this.#unacked -= this.#owed;
    this.#owed = 0;
    return credit;
  }
}
