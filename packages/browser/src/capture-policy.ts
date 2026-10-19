import type { BrowserCaptureViewport } from "@ace/protocol";

/*
 * How ace's Chrome captures a thread's page for its viewers: the frame size, cadence and JPEG
 * quality of the one screencast every viewer shares. Pure: the live capture feeds it the viewers
 * and how backed up they are.
 *
 * Bandwidth goes to resolution first: a viewer gets the pixels its screen shows (its pane's CSS
 * size times its device pixel ratio), not a fixed cap. When viewers fall behind, the frame rate
 * drops first; quality drops only when the backlog lasts, and never to a level that smears text.
 */

export interface CaptureViewer {
  viewport: BrowserCaptureViewport;
  local: boolean;
}

export interface CaptureSettings {
  fps: number;
  everyNthFrame: number;
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

/**
 * How backed up the viewers are: 0 keeping up, 1 a backlog (fewer frames), 2 a backlog that
 * lasted (fewer frames and lighter JPEGs).
 */
export type CaptureLoad = 0 | 1 | 2;

/** The long side of the largest frame: a 1280-px pane at DPR 2, a phone at DPR 3. */
export const longestFrameSide = 2560;
/** Viewers keeping up: loopback can take every frame, anything else half as many. */
const calmFps = { local: 30, remote: 15 };
/** A short backlog halves the rate; a lasting one drops to this. */
const lastingFps = 5;
const calmQuality = { local: 90, remote: 80 };
/** Still readable body text: the floor a lasting backlog may reach. */
const lastingQuality = 60;

/** One screencast for every viewer of the page: sized for the most demanding one. */
export function captureSettings(
  load: CaptureLoad,
  viewers: readonly CaptureViewer[] = [],
): CaptureSettings {
  const local = viewers.some((viewer) => viewer.local);
  let maxWidth = viewers.length ? 0 : 1280,
    maxHeight = viewers.length ? 0 : 960;
  for (const viewer of viewers) {
    const { width, height, devicePixelRatio } = viewer.viewport;
    const scale = Math.min(devicePixelRatio, longestFrameSide / Math.max(width, height));
    maxWidth = Math.max(maxWidth, Math.round(width * scale));
    maxHeight = Math.max(maxHeight, Math.round(height * scale));
  }
  const native = viewers.length > 0 && viewers.every((viewer) => viewer.viewport.nativeShown);
  const fps = local ? calmFps.local : calmFps.remote;
  return {
    fps: native ? 1 : load === 0 ? fps : load === 1 ? Math.ceil(fps / 2) : lastingFps,
    everyNthFrame: native ? 60 : 1,
    quality: load === 2 ? lastingQuality : local ? calmQuality.local : calmQuality.remote,
    maxWidth: Math.min(longestFrameSide, maxWidth),
    maxHeight: Math.min(longestFrameSide, maxHeight),
  };
}

/** Settings that differ only in frame rate apply without restarting the screencast. */
export function sameEncoding(a: CaptureSettings, b: CaptureSettings): boolean {
  return (
    a.everyNthFrame === b.everyNthFrame &&
    a.quality === b.quality &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight
  );
}

/** A backlog this long lowers the frame rate. */
const backlogMs = 500;
/** A backlog this long lowers quality too. */
const lastingMs = 3000;
/** Each second without a backlog undoes one step. */
const recoveryMs = 1000;

/**
 * Turns samples of "a viewer has a frame waiting" into a load level. Injected time: a short
 * decode wait changes nothing, a backlog steps down at once, and recovery is quick.
 */
export class CapturePressure {
  private since: number | undefined;
  private clearSince: number | undefined;
  private level: CaptureLoad = 0;
  sample(pending: boolean, now: number): CaptureLoad {
    if (pending) {
      this.clearSince = undefined;
      this.since ??= now;
      const held = now - this.since;
      if (held >= lastingMs) this.level = 2;
      else if (held >= backlogMs && this.level === 0) this.level = 1;
      return this.level;
    }
    this.since = undefined;
    this.clearSince ??= now;
    if (this.level > 0 && now - this.clearSince >= recoveryMs) {
      this.level = this.level === 2 ? 1 : 0;
      this.clearSince = now;
    }
    return this.level;
  }
}
