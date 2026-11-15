import { sceneFrameMs, type SceneClock, type SceneScheduler } from "./scene-controller.ts";

/*
 * One clock for every scene on the page (ADR 0150, "Scenes per region"): the app's backdrop and
 * each region's scene share 30 frames a second between them, never 30 each. A scene asks for its
 * next frame (`next`); the beat hands out one frame per 1/30 s, oldest ask first, so scenes that
 * keep asking take turns. Pausing, the watchdog and Reduce motion stay each scene's own
 * (`createSceneController`). Pure: time and timers come in.
 */

export interface SceneFrames {
  /** Runs `run` at this scene's next frame; the returned function gives the turn back. */
  next(run: () => void): () => void;
}

export function createSceneBeat(deps: {
  clock: SceneClock;
  scheduler: SceneScheduler;
}): SceneFrames {
  const { clock, scheduler } = deps;
  const waiting: { run: () => void }[] = [];
  let cancelTimer: (() => void) | undefined;
  let lastFrame = Number.NEGATIVE_INFINITY;
  const pump = () => {
    if (cancelTimer || waiting.length === 0) return;
    const wait = Math.max(0, lastFrame + sceneFrameMs - clock.now());
    cancelTimer = scheduler.after(wait, () => {
      cancelTimer = undefined;
      const turn = waiting.shift();
      if (turn) {
        lastFrame = clock.now();
        turn.run();
      }
      pump();
    });
  };
  return {
    next(run) {
      const turn = { run };
      waiting.push(turn);
      pump();
      return () => {
        const at = waiting.indexOf(turn);
        if (at !== -1) waiting.splice(at, 1);
        if (waiting.length === 0) {
          cancelTimer?.();
          cancelTimer = undefined;
        }
      };
    },
  };
}
