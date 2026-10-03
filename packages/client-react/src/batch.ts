/*
 * When store notifications reach React. A stream of 5,000 events a second should cost one
 * render per display frame, not one per socket message: with a frame batch, every selection
 * that changed during a frame notifies React together on the next animation frame, where
 * React renders them as one update. Hidden documents get no animation frames, so a background
 * tab does no rendering until it is shown again.
 */

export interface NotifyBatch {
  /** Run `listener` at the batch's next flush; repeated calls before it run it once. */
  schedule(listener: () => void): void;
  /** Drop a scheduled listener (its subscriber unsubscribed). */
  cancel(listener: () => void): void;
}

/** Notify at once: the default, and what tests use. */
export const immediate: NotifyBatch = {
  schedule: (listener) => listener(),
  cancel: () => {},
};

/** Coalesce notifications to one flush per frame of `requestFrame` (requestAnimationFrame). */
export function frameBatch(requestFrame: (flush: () => void) => unknown): NotifyBatch {
  let pending = new Set<() => void>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const due = pending;
    pending = new Set();
    for (const listener of due) {
      try {
        listener();
      } catch {
        /* One subscriber cannot stop the others' updates. */
      }
    }
  };
  return {
    schedule(listener) {
      pending.add(listener);
      if (scheduled) return;
      scheduled = true;
      requestFrame(flush);
    },
    cancel(listener) {
      pending.delete(listener);
    },
  };
}
