import type { EngineClock } from "../engine/actor.ts";

/** Longest one operation waits, in all, for ace's model lists to be ready and to load. */
export const modelLoadWaitMs = 20_000;

/**
 * How long one operation may wait for model lists: a single deadline that starts when the
 * budget is made and is shared by every step that waits (startup readiness, matching a model
 * name, preparing the launch), so a stalled account delays the operation once, not per step.
 */
export interface ModelLoadBudget {
  /**
   * True when `work` finished before the deadline, false once the deadline passed first. Rejects
   * with `work`'s failure, or with the operation's cancellation as soon as it is cancelled; work
   * still running carries on in the background.
   */
  wait(work: Promise<unknown>): Promise<boolean>;
  /** The same deadline without cancellation, for work that outlives the call that started it. */
  detached(): ModelLoadBudget;
  /** Stop the deadline's timer once the operation is done with it. */
  end(): void;
}

export function modelLoadBudget(
  clock: EngineClock,
  signal?: AbortSignal,
  milliseconds = modelLoadWaitMs,
): ModelLoadBudget {
  let cancel: (() => void) | undefined;
  const expired = new Promise<false>((resolve) => {
    cancel = clock.setTimer(() => resolve(false), milliseconds);
  });
  return budget(expired, () => cancel?.(), signal);
}

function budget(
  expired: Promise<false>,
  end: () => void,
  signal: AbortSignal | undefined,
): ModelLoadBudget {
  return {
    async wait(work: Promise<unknown>): Promise<boolean> {
      signal?.throwIfAborted();
      const done = work.then(() => true as const);
      // Work still running when the wait ends must not surface later as an unhandled failure.
      done.catch(() => {});
      if (!signal) return Promise.race([done, expired]);
      let stop: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
      });
      try {
        return await Promise.race([done, expired, aborted]);
      } finally {
        if (stop) signal.removeEventListener("abort", stop);
      }
    },
    detached: () => budget(expired, end, undefined),
    end,
  };
}
