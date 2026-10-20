/*
 * What the live screen's subtitle says about its stream ("H.264 · 59 fps · 35 ms"), from the
 * frames it showed. Live views are H.264 only. Pure: callers pass each frame's capture time and
 * the time it was shown.
 */

export interface ShownFrame {
  /** When the frame was captured, on the daemon's clock (milliseconds). */
  capturedAt: number;
  /** When it was drawn, on the page's wall clock. */
  shownAt: number;
}

export interface StreamStats {
  /** Frames drawn in the last second; undefined until a second has passed. */
  fps: number | undefined;
  /** Capture to screen, when both clocks are the same machine's; undefined otherwise. */
  latencyMs: number | undefined;
}

const windowMs = 1000;

/** A rolling second of shown frames, for the subtitle. Memory stays bounded by the frame rate. */
export class StreamMeter {
  private frames: ShownFrame[] = [];
  private readonly sameClock: boolean;
  constructor(options: { sameClock: boolean }) {
    this.sameClock = options.sameClock;
  }

  add(frame: ShownFrame): void {
    this.frames.push(frame);
    const cutoff = frame.shownAt - windowMs * 2;
    while (this.frames.length && (this.frames[0]?.shownAt ?? 0) < cutoff) this.frames.shift();
  }

  /** The stats as of `now`; undefined before the first frame or after a quiet second. */
  read(now: number): StreamStats | undefined {
    const recent = this.frames.filter((frame) => frame.shownAt > now - windowMs);
    const last = this.frames.at(-1);
    if (!last) return undefined;
    const first = this.frames[0];
    const spanned = first !== undefined && now - first.shownAt >= windowMs;
    const latencies = recent.map((frame) => frame.shownAt - frame.capturedAt);
    const latency = latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : undefined;
    return {
      fps: spanned ? recent.length : undefined,
      latencyMs:
        this.sameClock && latency !== undefined && latency >= 0 && latency < 10_000
          ? latency
          : undefined,
    };
  }
}

/** "H.264 · 59 fps · 35 ms", leaving out what isn't known. */
export function streamSummary(stats: StreamStats | undefined): string[] {
  if (!stats) return [];
  return [
    "H.264",
    // A still screen sends no frames; "0 fps" would read as a broken stream.
    ...(stats.fps ? [`${stats.fps} fps`] : []),
    ...(stats.latencyMs === undefined ? [] : [`${stats.latencyMs} ms`]),
  ];
}
