/**
 * One screen session's frames arrive on two paths while its video moves between them: the
 * helper's own socket to the daemon, and ace-media's egress (docs/media/plan.md, "Routes and
 * setting combinations"). The helper switches at an exact boundary, the sequence of the last
 * frame the previous path took, and starts the new path at a keyframe. This merge hands frames
 * on in sequence order: frames on the new path wait until the previous path has delivered its
 * boundary (or `holdMs` passes), so a switch loses and repeats nothing. A frame older than one
 * already handed on is dropped. Pure: time is the injected scheduler's.
 */

export type FramePath = "daemon" | "media";

export type PathMergeOptions<F> = {
  sequence: (frame: F) => number;
  emit: (frame: F) => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
  /** Longest a switch holds the new path's frames for the previous path's boundary. */
  holdMs?: number;
};

type Pending<F> = {
  to: FramePath;
  /** undefined until the helper has answered with the boundary. */
  boundary: number | null | undefined;
  held: F[];
  cancel: (() => void) | undefined;
};

export const defaultHoldMs = 500;

export class PathMerge<F> {
  readonly #options: PathMergeOptions<F>;
  #last = -1;
  #pending: Pending<F> | undefined;
  #stale = 0;

  constructor(options: PathMergeOptions<F>) {
    this.#options = options;
  }

  /** Frames dropped because a newer one was already handed on. */
  get stale(): number {
    return this.#stale;
  }

  frame(path: FramePath, frame: F): void {
    const sequence = this.#options.sequence(frame);
    if (sequence <= this.#last) {
      this.#stale++;
      return;
    }
    const pending = this.#pending;
    if (pending && path === pending.to && !this.#reached(pending)) {
      pending.held.push(frame);
      return;
    }
    this.#emit(frame, sequence);
    if (pending && this.#reached(pending)) this.#release();
  }

  /** A switch to `to` was asked for: its frames wait until the helper says where it switched. */
  switching(to: FramePath): void {
    this.#release();
    this.#pending = { to, boundary: undefined, held: [], cancel: undefined };
    this.#arm();
  }

  /** The helper switched to `to`; frames up to `boundary` come on the previous path. */
  switched(to: FramePath, boundary: number | null): void {
    const pending = this.#pending?.to === to ? this.#pending : undefined;
    if (!pending) {
      this.#release();
      this.#pending = { to, boundary, held: [], cancel: undefined };
    } else pending.boundary = boundary;
    if (this.#reached(this.#pending)) this.#release();
    else this.#arm();
  }

  /** The request didn't switch (or failed): nothing waits. */
  unchanged(): void {
    this.#release();
  }

  /** ace-media's path is gone; nothing more will come on it. */
  mediaClosed(): void {
    this.#release();
  }

  dispose(): void {
    this.#pending?.cancel?.();
    this.#pending = undefined;
  }

  #reached(pending: Pending<F> | undefined): boolean {
    if (!pending || pending.boundary === undefined) return false;
    return pending.boundary === null || this.#last >= pending.boundary;
  }

  #arm(): void {
    const pending = this.#pending;
    if (!pending) return;
    pending.cancel?.();
    pending.cancel = this.#options.schedule(() => {
      if (this.#pending === pending) this.#release();
    }, this.#options.holdMs ?? defaultHoldMs);
  }

  #release(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.cancel?.();
    const { sequence } = this.#options;
    pending.held.sort((a, b) => sequence(a) - sequence(b));
    for (const frame of pending.held) {
      const next = sequence(frame);
      if (next <= this.#last) this.#stale++;
      else this.#emit(frame, next);
    }
  }

  #emit(frame: F, sequence: number): void {
    this.#last = sequence;
    this.#options.emit(frame);
  }
}
