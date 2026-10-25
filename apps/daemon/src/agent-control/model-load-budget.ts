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
  /**
   * The same deadline without cancellation, for work that outlives the call that started it.
   * It holds the deadline too: the timer stops only once every holder has ended.
   */
  detached(): ModelLoadBudget;
  /** This holder is done with the deadline; once every holder is, its timer stops. */
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
  const deadline = { expired, holders: 0, stop: () => cancel?.() };
  return holder(deadline, signal);
}

interface Deadline {
  readonly expired: Promise<false>;
  holders: number;
  stop(): void;
}

function holder(deadline: Deadline, signal: AbortSignal | undefined): ModelLoadBudget {
  deadline.holders += 1;
  let ended = false;
  return {
    async wait(work: Promise<unknown>): Promise<boolean> {
      const done = work.then(() => true as const);
      // Work whose wait ends early (cancelled, or past the deadline) must not surface later as an
      // unhandled failure; handled before anything here can return.
      done.catch(() => {});
      signal?.throwIfAborted();
      if (!signal) return Promise.race([done, deadline.expired]);
      let stop: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
      });
      try {
        return await Promise.race([done, deadline.expired, aborted]);
      } finally {
        if (stop) signal.removeEventListener("abort", stop);
      }
    },
    detached: () => holder(deadline, undefined),
    end() {
      if (ended) return;
      ended = true;
      deadline.holders -= 1;
      if (deadline.holders === 0) deadline.stop();
    },
  };
}
