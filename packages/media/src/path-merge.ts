/**
 * One source's units while its producer moves between two paths (docs/media/plan.md, "Path
 * merge"): the daemon's own (CDP binding, backend socket, helper socket) and ace-media's
 * egress. A producer sends each unit one way only, but the two paths race, so a new path's
 * first keyframe can overtake the old path's last deltas, which would then reach the decoder
 * out of order and break its references.
 *
 * The merge hands units on in path order. After `switching(to)`, the new path's units wait
 * until the old path's ordered end arrives (`ended`): ace-media's egress end marker, or the
 * producer's own word on the daemon's path that it moved. A clean end releases them all; an
 * interrupted end, or no end within `holdMs`, releases each stream from its next keyframe and
 * drops whatever the old path still sends. A sequence boundary (the screen helper's) maps to
 * `ended` once its last unit has been delivered. Pure: time is the injected scheduler's.
 */

export type PathMergeOptions<U> = {
  emit: (unit: U) => void;
  /** The encode a unit belongs to: each starts again at its own keyframe. */
  stream: (unit: U) => string | number;
  key: (unit: U) => boolean;
  /** A unit's size, for the hold's budget. */
  bytes: (unit: U) => number;
  /**
   * Most bytes a switch holds while it waits. Past it the old path is given up on, as on a
   * timeout: each stream starts at its next keyframe.
   */
  maxHeldBytes?: number;
  schedule: (callback: () => void, milliseconds: number) => () => void;
  /** Longest the new path waits for the old path's end. */
  holdMs?: number;
};

export const defaultHoldMs = 1_000;
export const defaultMaxHeldBytes = 32 * 1024 * 1024;

type Pending<U> = { from: string; to: string; held: U[]; bytes: number; cancel: () => void };

export class PathMerge<U> {
  readonly #options: PathMergeOptions<U>;
  #current: string;
  #pending: Pending<U> | undefined;
  /** Paths that ended or were given up on: nothing more of theirs is handed on. */
  readonly #closed = new Set<string>();
  /** After a cut, the streams that have had their keyframe; undefined when none is owed. */
  #keyed: Set<string | number> | undefined;
  #stale = 0;

  constructor(initial: string, options: PathMergeOptions<U>) {
    this.#current = initial;
    this.#options = options;
  }

  /** Units dropped: from a path given up on, or deltas waiting for their keyframe. */
  get stale(): number {
    return this.#stale;
  }

  deliver(path: string, unit: U): void {
    const pending = this.#pending;
    if (pending && path === pending.to) {
      pending.held.push(unit);
      pending.bytes += this.#options.bytes(unit);
      if (pending.bytes > (this.#options.maxHeldBytes ?? defaultMaxHeldBytes)) this.#settle(true);
      return;
    }
    if (path !== this.#current || this.#closed.has(path)) {
      this.#stale++;
      return;
    }
    this.#emit(unit);
  }

  /** The producer is moving to `to`: its units wait for the current path's end. */
  switching(to: string): void {
    // Told again (by the daemon and then by the producer): still the one switch.
    const pending = this.#pending;
    if (pending?.to === to) return;
    if (pending && to === pending.from) {
      // Abandoned before the old path ended (the producer never got there): the old path goes
      // on, and whatever came on the new one is dropped.
      this.#pending = undefined;
      pending.cancel();
      this.#closed.add(pending.to);
      this.#stale += pending.held.length;
      return;
    }
    if (pending) this.#settle(true);
    if (to === this.#current) return;
    this.#closed.delete(to);
    const next: Pending<U> = {
      from: this.#current,
      to,
      held: [],
      bytes: 0,
      cancel: () => {},
    };
    next.cancel = this.#options.schedule(() => {
      if (this.#pending === next) this.#settle(true);
    }, this.#options.holdMs ?? defaultHoldMs);
    this.#pending = next;
  }

  /** `path`'s ordered end: nothing more comes on it. `interrupted` when units may be missing. */
  ended(path: string, interrupted: boolean): void {
    const pending = this.#pending;
    if (pending && path === pending.from) {
      this.#settle(interrupted);
      return;
    }
    if (path !== this.#current) this.#closed.add(path);
  }

  dispose(): void {
    this.#pending?.cancel();
    this.#pending = undefined;
  }

  #settle(interrupted: boolean): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.cancel();
    this.#closed.add(pending.from);
    this.#current = pending.to;
    if (interrupted) this.#keyed = new Set();
    for (const unit of pending.held) this.#emit(unit);
  }

  #emit(unit: U): void {
    const keyed = this.#keyed;
    if (keyed) {
      const stream = this.#options.stream(unit);
      if (!keyed.has(stream)) {
        if (!this.#options.key(unit)) {
          this.#stale++;
          return;
        }
        keyed.add(stream);
      }
    }
    this.#options.emit(unit);
  }
}
