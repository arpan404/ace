import { nextFrame } from "./next-frame.ts";

export interface FrameThrottle {
  /** Ask for a run in the next frame; asks before it runs share that one run. */
  request(): void;
  cancel(): void;
}

/**
 * Runs `run` at most once per frame however often it is requested (scroll events arrive many
 * times a frame). `frame` schedules the run and returns its cancel; injected for tests.
 */
export function frameThrottle(
  run: () => void,
  frame: (callback: () => void) => () => void = nextFrame,
): FrameThrottle {
  let pending: (() => void) | undefined;
  return {
    request() {
      if (pending) return;
      pending = frame(() => {
        pending = undefined;
        run();
      });
    },
    cancel() {
      pending?.();
      pending = undefined;
    },
  };
}
