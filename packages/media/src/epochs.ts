/**
 * The daemon's side of the recording privacy barrier (docs/media/plan.md, "Recording privacy
 * barrier"). Pure: `now` is the daemon's own monotonic milliseconds, the only clock that
 * orders anything here.
 *
 * - The daemon issues a source's epochs: on every privacy transition and every 100 ms while it
 *   is recorded. `sent(k)` is when it gave epoch k to the producer.
 * - Epoch k is decided once the producer acknowledges a later epoch: it is clear only if the
 *   source was public from `sent(k)` until that acknowledgement, and discarded otherwise.
 * - A producer silent for 2 s gets every open epoch discarded; the caller then issues a fresh
 *   epoch and asks for a keyframe.
 * - Decisions go out as one sequenced stream (`record.epochs`), `seq` from 0 per ace-media
 *   process.
 */

/** How often a recorded source gets a new epoch. */
export const epochIntervalMs = 100;
/** How long a producer may leave an epoch unacknowledged before open epochs are discarded. */
export const acknowledgementTimeoutMs = 2_000;
/** How long a read-time producer keeps the private epoch after applying the next one. */
export const readGapMs = 100;

export type EpochRange = [from: number, to: number];
export type EpochDecision = {
  seq: number;
  decided: number;
  clear: EpochRange[];
  discard: EpochRange[];
};
export type IssuedEpoch = { epoch: number; followsPrivate: boolean };

type Change = { at: number; private: boolean };

export class EpochLedger {
  #current: number;
  /** When each undecided epoch was sent, from `#undecided` to `#current`. */
  #sent = new Map<number, number>();
  #undecided: number;
  /** The lowest epoch the producer hasn't acknowledged yet. */
  #awaiting: number;
  #seq = 0;
  /** Privacy as of the first change, then every transition after it, oldest first. */
  #changes: Change[];

  /** `epoch` is the source's current epoch, sent at `now`. */
  constructor(start: { epoch: number; private: boolean; now: number }) {
    this.#current = start.epoch;
    this.#undecided = start.epoch;
    this.#awaiting = start.epoch + 1;
    this.#sent.set(start.epoch, start.now);
    this.#changes = [{ at: start.now, private: start.private }];
  }

  get current(): number {
    return this.#current;
  }

  /** The next epoch, on a privacy transition (`private` changed) or the 100 ms beat. */
  issue(now: number, isPrivate: boolean): IssuedEpoch {
    const followsPrivate = this.#privateDuring(this.#sentAt(this.#current), now);
    this.#record(now, isPrivate);
    this.#current += 1;
    this.#sent.set(this.#current, now);
    return { epoch: this.#current, followsPrivate };
  }

  /** The producer applied `epoch` (and so every one before it). The decisions that settles. */
  acknowledged(epoch: number, now: number): EpochDecision | undefined {
    if (epoch < this.#awaiting || epoch > this.#current) return undefined;
    this.#awaiting = epoch + 1;
    return this.#decide(epoch - 1, (k) => !this.#privateDuring(this.#sentAt(k), now));
  }

  /**
   * Discards every open epoch if the producer has left one unacknowledged for 2 s. The caller
   * then issues a new epoch and asks for a keyframe.
   */
  expire(now: number): EpochDecision | undefined {
    const waiting = this.#sent.get(this.#awaiting);
    if (waiting === undefined || now - waiting < acknowledgementTimeoutMs) return undefined;
    this.#awaiting = this.#current + 1;
    return this.#decide(this.#current, () => false);
  }

  /**
   * A new ace-media process: `seq` starts at 0 and it hears the current epoch again. Frames it
   * held are lost, so epochs below the current one are never decided to it.
   */
  restart(): void {
    this.#seq = 0;
    for (let k = this.#undecided; k < this.#current; k++) this.#sent.delete(k);
    this.#undecided = this.#current;
    this.#awaiting = Math.max(this.#awaiting, this.#current);
  }

  #sentAt(epoch: number): number {
    // Every undecided epoch has a send time; a decided one can't be asked about.
    return this.#sent.get(epoch) ?? this.#changes[0]?.at ?? 0;
  }

  #record(now: number, isPrivate: boolean): void {
    const last = this.#changes[this.#changes.length - 1];
    if (last?.private !== isPrivate) this.#changes.push({ at: now, private: isPrivate });
  }

  /** Whether the source was private at any moment of `[from, to]`. */
  #privateDuring(from: number, to: number): boolean {
    let before = this.#changes[0]?.private ?? true;
    for (const change of this.#changes) {
      if (change.at <= from) before = change.private;
      else if (change.at <= to && change.private) return true;
    }
    return before;
  }

  #decide(upTo: number, clear: (epoch: number) => boolean): EpochDecision | undefined {
    if (upTo < this.#undecided) return undefined;
    const verdicts: { epoch: number; clear: boolean }[] = [];
    for (let k = this.#undecided; k <= upTo; k++) verdicts.push({ epoch: k, clear: clear(k) });
    for (let k = this.#undecided; k <= upTo; k++) this.#sent.delete(k);
    this.#undecided = upTo + 1;
    this.#prune();
    return {
      seq: this.#seq++,
      decided: upTo,
      clear: ranges(verdicts.filter((v) => v.clear).map((v) => v.epoch)),
      discard: ranges(verdicts.filter((v) => !v.clear).map((v) => v.epoch)),
    };
  }

  /** Forgets transitions before the oldest open epoch was sent, keeping the state then. */
  #prune(): void {
    const oldest = this.#sent.get(this.#undecided);
    if (oldest === undefined) return;
    let keep = 0;
    for (let i = 0; i < this.#changes.length; i++) {
      if ((this.#changes[i]?.at ?? Infinity) <= oldest) keep = i;
    }
    if (keep > 0) this.#changes.splice(0, keep);
  }
}

function ranges(epochs: number[]): EpochRange[] {
  const out: EpochRange[] = [];
  for (const epoch of epochs) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === epoch) last[1] = epoch;
    else out.push([epoch, epoch]);
  }
  return out;
}

/**
 * The stamping rule for a producer that learns a frame's time only when it reads it, such as
 * the daemon's tee into ace-media. After applying an epoch that follows a private one, frames
 * read less than 100 ms later still get the private epoch: the capture queue may still hold
 * pictures from then. Later applies don't shorten that window. Same rule as
 * `media-core::privacy::ReadStamper`, checked against the same vectors.
 */
export class ReadStamper {
  #current: number;
  #hold: { epoch: number; until: number } | undefined;

  constructor(epoch: number) {
    this.#current = epoch;
  }

  apply(epoch: number, followsPrivate: boolean, now: number): void {
    if (followsPrivate) this.#hold = { epoch: this.#current, until: now + readGapMs };
    this.#current = epoch;
  }

  stamp(now: number): number {
    const hold = this.#hold;
    return hold && now < hold.until ? hold.epoch : this.#current;
  }
}
