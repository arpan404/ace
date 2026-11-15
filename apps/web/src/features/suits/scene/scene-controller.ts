import { SceneMessage, type SceneHostMessage, type SceneSignal } from "@ace/protocol/suits";
import type { SuitSceneRegion } from "@ace/protocol/suit-parts";

/**
 * What decides a scene's frames (ADR 0150, "Scenes"). ace owns the clock: this sends `init`,
 * then at most 30 ticks a second while the scene may run, and pauses it when the page is hidden,
 * the window has been blurred for 10 s, the device saves power, or Reduce motion is on (one
 * still frame). It also watches the scene: no `ready` within 3 s, an `error`, or three frames in
 * a row drawn more than 100 ms after their tick stop it for good. Pure: time and timers come in.
 */

export const sceneFrameMs = 1000 / 30;
export const sceneReadyTimeoutMs = 3000;
export const sceneLateFrameMs = 100;
export const sceneLateFramesAllowed = 2;
export const sceneBlurPauseMs = 10_000;

export type Scheme = "light" | "dark";

export interface SceneClock {
  now(): number;
}

export interface SceneScheduler {
  /** Runs `run` once after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

export type SceneStop =
  | { reason: "no-ready" }
  | { reason: "error"; message: string }
  | { reason: "slow" };

export interface SceneViewport {
  width: number;
  height: number;
  pixelRatio: number;
}

export interface SceneStart extends SceneViewport {
  scheme: Scheme;
  reduceMotion: boolean;
  visible: boolean;
  focused: boolean;
  lowPower: boolean;
  /** The region the frame runs in, told to the scene in `init` (`view.region`). */
  region?: SuitSceneRegion | undefined;
  /** A signal the scene hears as soon as it is ready: what woke a celebration. */
  wake?: SceneSignal | undefined;
}

export interface SceneControllerDeps {
  clock: SceneClock;
  scheduler: SceneScheduler;
  post(message: SceneHostMessage): void;
  /** Called once when the watchdog stops the scene; the host unmounts it. */
  stopped(stop: SceneStop): void;
  /** A celebration said it has played out (`ace.finish()`); the host may take it down. */
  finished?: (() => void) | undefined;
  /**
   * Where frames come from when scenes share one clock (`createSceneBeat`); without it this
   * scene keeps its own 30 a second.
   */
  frames?: { next(run: () => void): () => void } | undefined;
}

export interface SceneController {
  start(): void;
  receive(message: SceneMessage): void;
  setVisible(visible: boolean): void;
  setFocused(focused: boolean): void;
  setLowPower(lowPower: boolean): void;
  setReduceMotion(reduceMotion: boolean): void;
  setScheme(scheme: Scheme): void;
  resize(viewport: SceneViewport): void;
  signal(signal: SceneSignal): void;
  /** Stops all timers without reporting a failure (the host went away). */
  dispose(): void;
}

/** The message, when it came from the scene's own frame and is one a scene may send. */
export function messageFromScene(
  event: { source: unknown; data: unknown },
  frame: unknown,
): SceneMessage | undefined {
  if (frame === null || frame === undefined || event.source !== frame) return undefined;
  const parsed = SceneMessage.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

export function createSceneController(
  initial: SceneStart,
  deps: SceneControllerDeps,
): SceneController {
  const { clock, scheduler, post } = deps;
  const facts = { ...initial, blurredLong: false };
  let phase: "idle" | "starting" | "ready" | "over" = "idle";
  let ticking = false;
  let pauseSent = false;
  let lateFrames = 0;
  let outstanding: { time: number; sentAt: number } | undefined;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  // Scene time runs only while ticking, so a scene resumes where it paused.
  let sceneTime = 0;
  let runningSince = 0;
  let cancelReady: (() => void) | undefined;
  let cancelTick: (() => void) | undefined;
  let cancelBlur: (() => void) | undefined;

  const cancelAll = () => {
    cancelReady?.();
    cancelTick?.();
    cancelBlur?.();
    cancelReady = cancelTick = cancelBlur = undefined;
    ticking = false;
  };
  const stop = (reason: SceneStop) => {
    if (phase === "over") return;
    phase = "over";
    cancelAll();
    deps.stopped(reason);
  };
  const mayRun = () =>
    phase === "ready" &&
    facts.visible &&
    !facts.blurredLong &&
    !facts.lowPower &&
    !facts.reduceMotion;
  const now = () => (ticking ? sceneTime + clock.now() - runningSince : sceneTime);

  /** Asks for the next frame `wait` ms on (its own clock) or at its turn (a shared one). */
  const nextFrame = (wait: number) =>
    deps.frames ? deps.frames.next(frameDue) : scheduler.after(wait, frameDue);
  const sendTick = () => {
    const time = now();
    lastSentAt = clock.now();
    outstanding = { time, sentAt: lastSentAt };
    post({ type: "tick", time });
  };
  const countLate = () => {
    lateFrames += 1;
    if (lateFrames > sceneLateFramesAllowed) stop({ reason: "slow" });
  };
  const frameDue = () => {
    cancelTick = undefined;
    if (!ticking) return;
    if (outstanding) {
      // Still drawing the last one: once that is late it counts, and a later answer is ignored.
      if (clock.now() - outstanding.sentAt <= sceneLateFrameMs) {
        cancelTick = nextFrame(sceneFrameMs);
        return;
      }
      outstanding = undefined;
      countLate();
      if (phase === "over") return;
    }
    sendTick();
    cancelTick = nextFrame(sceneFrameMs);
  };
  /** One frame for a scene that may not move: under Reduce motion it shows as a still. */
  const stillFrame = () => {
    if (phase === "ready" && facts.reduceMotion && !ticking) sendTick();
  };

  const update = () => {
    if (phase !== "ready") return;
    if (mayRun() && !ticking) {
      if (pauseSent) post({ type: "resume" });
      pauseSent = false;
      ticking = true;
      runningSince = clock.now();
      // Never faster than 30 a second, even across a quick pause and resume.
      const wait = Math.max(0, lastSentAt + sceneFrameMs - clock.now());
      cancelTick = nextFrame(wait);
    } else if (!mayRun() && (ticking || !pauseSent)) {
      if (ticking) sceneTime += clock.now() - runningSince;
      ticking = false;
      cancelTick?.();
      cancelTick = undefined;
      post({ type: "pause" });
      pauseSent = true;
    }
  };

  return {
    start() {
      if (phase !== "idle") return;
      phase = "starting";
      post({
        type: "init",
        scheme: facts.scheme,
        width: facts.width,
        height: facts.height,
        pixelRatio: facts.pixelRatio,
        reduceMotion: facts.reduceMotion,
        ...(facts.region ? { region: facts.region } : {}),
      });
      cancelReady = scheduler.after(sceneReadyTimeoutMs, () => stop({ reason: "no-ready" }));
    },
    receive(message) {
      if (phase === "over") return;
      // A scene's script can fail while its page is still loading, before `start`.
      if (message.type === "error") return stop({ reason: "error", message: message.message });
      if (phase === "idle") return;
      // Samples answer the live check (`scene-sample.ts`), not the clock.
      if (message.type === "sample") return;
      if (message.type === "finished") {
        if (phase === "ready") deps.finished?.();
        return;
      }
      if (message.type === "ready") {
        if (phase !== "starting") return;
        cancelReady?.();
        cancelReady = undefined;
        phase = "ready";
        if (facts.wake) post({ type: "signal", signal: facts.wake });
        stillFrame();
        update();
        return;
      }
      if (!outstanding || message.time !== outstanding.time) return;
      const late = clock.now() - outstanding.sentAt > sceneLateFrameMs;
      outstanding = undefined;
      // Only a run of late frames is the scene's: a busy page delays one answer now and then.
      if (late) countLate();
      else lateFrames = 0;
    },
    setVisible(visible) {
      facts.visible = visible;
      update();
    },
    setFocused(focused) {
      if (facts.focused === focused) return;
      facts.focused = focused;
      cancelBlur?.();
      cancelBlur = undefined;
      if (focused) {
        facts.blurredLong = false;
        update();
        return;
      }
      if (phase === "over") return;
      cancelBlur = scheduler.after(sceneBlurPauseMs, () => {
        cancelBlur = undefined;
        facts.blurredLong = true;
        update();
      });
    },
    setLowPower(lowPower) {
      facts.lowPower = lowPower;
      update();
    },
    setReduceMotion(reduceMotion) {
      if (facts.reduceMotion === reduceMotion) return;
      facts.reduceMotion = reduceMotion;
      if (phase === "over" || phase === "idle") return;
      post({ type: "motion", reduceMotion });
      update();
      stillFrame();
    },
    setScheme(scheme) {
      if (facts.scheme === scheme) return;
      facts.scheme = scheme;
      if (phase === "over" || phase === "idle") return;
      post({ type: "scheme", scheme });
      stillFrame();
    },
    resize(viewport) {
      const same =
        viewport.width === facts.width &&
        viewport.height === facts.height &&
        viewport.pixelRatio === facts.pixelRatio;
      Object.assign(facts, viewport);
      if (same || phase === "over" || phase === "idle") return;
      post({ type: "resize", ...viewport });
      stillFrame();
    },
    signal(signal) {
      if (phase === "ready") post({ type: "signal", signal });
    },
    dispose() {
      phase = "over";
      cancelAll();
    },
  };
}
