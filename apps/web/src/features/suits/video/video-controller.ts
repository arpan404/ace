/*
 * How a Suit's video plays (ADR 0169), over a narrow view of the `<video>` element so the rules
 * are tested without a decoder. It plays only while the window is visible and motion and power
 * allow; the Suit's `audio` decides the sound; a browser that refuses sound without a gesture
 * gets the video muted until the person's first click or key; the position is kept per Suit
 * so a reload or reconnect picks up where it was; a video that fails three times is dropped.
 */

/** The parts of `HTMLVideoElement` the controller uses. */
export interface VideoElementLike {
  muted: boolean;
  volume: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void> | undefined;
  pause(): void;
  load(): void;
}

export interface VideoFacts {
  visible: boolean;
  /** Reduce motion: the poster, no playback. */
  still: boolean;
  savingPower: boolean;
}

export interface VideoAudio {
  muted: boolean;
  volume: number;
}

/** Where the position of one version of a Suit's video is kept between runs. */
export interface PositionStore {
  read(): number | undefined;
  write(seconds: number): void;
}

export interface VideoControllerOptions {
  element: VideoElementLike;
  audio: VideoAudio;
  position: PositionStore;
  after(ms: number, run: () => void): () => void;
  /** The video failed for good; the Suit carries on with its poster and colours. */
  stopped(): void;
}

export const videoFailureLimit = 3;
/** How often, at most, the position is written while it plays. */
export const positionEveryMs = 5_000;
const retryMs = [1_000, 4_000];

export const shouldPlay = (facts: VideoFacts) =>
  facts.visible && !facts.still && !facts.savingPower;

export interface VideoController {
  /** The window's facts changed: play or pause to match. */
  facts(next: VideoFacts): void;
  /** The file's metadata arrived: seek to the kept position. */
  loaded(): void;
  /** The element's position moved (`timeupdate`). */
  progressed(now: number): void;
  /** The element failed to load or decode. */
  failed(): void;
  /** The person clicked or pressed a key: sound the browser held back may play now. */
  gesture(): void;
  /** Whether sound waits for a gesture. */
  waitingForGesture(): boolean;
  dispose(): void;
}

const notAllowed = (error: unknown) =>
  error instanceof Error && (error.name === "NotAllowedError" || error.name === "NotSupportedError")
    ? error.name
    : undefined;

const noop = () => {};

export function createVideoController(options: VideoControllerOptions): VideoController {
  const { element, audio, position } = options;
  let facts: VideoFacts = { visible: false, still: true, savingPower: false };
  let held = false;
  let failures = 0;
  let gone = false;
  let disposed = false;
  let lastWrite = Number.NEGATIVE_INFINITY;
  let cancelRetry = noop;

  element.muted = audio.muted;
  element.volume = Math.min(1, Math.max(0, audio.volume));

  const save = () => {
    if (Number.isFinite(element.currentTime)) position.write(element.currentTime);
  };

  const start = () => {
    if (gone || disposed || !shouldPlay(facts) || !element.paused) return;
    const playing = element.play();
    playing?.catch((error: unknown) => {
      if (disposed || gone || notAllowed(error) !== "NotAllowedError") return;
      // Sound without a gesture is refused here: play muted, and sound on the first gesture.
      if (element.muted) return;
      held = true;
      element.muted = true;
      if (shouldPlay(facts)) element.play()?.catch(() => {});
    });
  };

  return {
    facts(next) {
      facts = next;
      if (shouldPlay(next)) start();
      else if (!element.paused) {
        element.pause();
        save();
      }
    },
    loaded() {
      const kept = position.read();
      const duration = element.duration;
      if (kept !== undefined && Number.isFinite(duration) && duration > 0)
        element.currentTime = kept % duration;
      failures = 0;
      start();
    },
    progressed(now) {
      if (now - lastWrite < positionEveryMs) return;
      lastWrite = now;
      save();
    },
    failed() {
      if (gone || disposed) return;
      failures += 1;
      if (failures >= videoFailureLimit) {
        gone = true;
        cancelRetry();
        options.stopped();
        return;
      }
      cancelRetry();
      cancelRetry = options.after(retryMs[failures - 1] ?? 4_000, () => {
        if (disposed || gone) return;
        element.load();
      });
    },
    gesture() {
      if (!held || disposed) return;
      held = false;
      element.muted = audio.muted;
      start();
    },
    waitingForGesture: () => held,
    dispose() {
      if (disposed) return;
      save();
      disposed = true;
      cancelRetry();
      element.pause();
    },
  };
}

/**
 * A position store over `storage`, one key per Suit: an edit to its colours keeps the music where
 * it was, and a shorter new cut wraps (`loaded`).
 */
export function storedPosition(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  key: string,
): PositionStore {
  return {
    read() {
      try {
        const value = Number(storage?.getItem(key));
        return storage?.getItem(key) != null && Number.isFinite(value) && value >= 0
          ? value
          : undefined;
      } catch {
        return undefined;
      }
    },
    write(seconds) {
      try {
        storage?.setItem(key, String(Math.round(seconds * 10) / 10));
      } catch {
        // A full or blocked storage only loses the position.
      }
    },
  };
}

export const positionKey = (suitId: string) => `ace.suit-video-position.${suitId}`;
