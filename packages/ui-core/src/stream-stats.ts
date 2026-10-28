/*
 * What the live screen says about its stream: the subtitle ("H.264 · 59 fps · 35 ms") and, when
 * asked for, a few numbers that show where pictures go missing (received vs drawn, bit rate,
 * the longest stall, keyframes asked for). Live views are H.264 only. Pure: callers pass times.
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
  /** Pictures that reached this page in the last second. */
  receivedFps: number;
  /** What those pictures weighed, in megabits. */
  megabits: number;
  /** The longest wait between two drawn frames in the last five seconds. */
  longestGapMs: number;
  /** Keyframes this view asked for in the last five seconds (a lost place, a decode error). */
  keyframesAsked: number;
  /** Which decoder the view asked for, and why it fell back, as far as WebCodecs lets it know. */
  decoder: { preference: "hardware" | "default"; reason?: string } | undefined;
  /**
   * The screen is holding still: a Simulator re-sends its unchanged picture about five times a
   * second, which would otherwise read as a stream that dropped to 5 fps.
   */
  still: boolean;
}

const windowMs = 1000;
const historyMs = 5000;
/**
 * A drawn rate at or under this, of pictures this small, is a still screen's re-sends: about
 * five a second, one or two more when the clock or a cursor ticks. Measured with serve-sim
 * 0.1.49 on iOS 27, a still screen's pictures weigh 0.3 to 4.4 KB (an iPhone 18 Pro Max's App
 * Library); a moving screen's at this rate weigh far more.
 */
const stillFps = 7;
const stillBytes = 8192;

const trim = <T>(entries: T[], at: (entry: T) => number, cutoff: number) => {
  while (entries.length && at(entries[0] as T) < cutoff) entries.shift();
};

/** A rolling window of the stream, for the subtitle and the stats. Memory stays bounded. */
export class StreamMeter {
  private frames: ShownFrame[] = [];
  private received: { at: number; bytes: number }[] = [];
  private asked: number[] = [];
  private decoderChoice: StreamStats["decoder"];
  private readonly sameClock: boolean;
  constructor(options: { sameClock: boolean }) {
    this.sameClock = options.sameClock;
  }

  /** A frame was drawn. */
  add(frame: ShownFrame): void {
    this.frames.push(frame);
    trim(this.frames, (entry) => entry.shownAt, frame.shownAt - historyMs);
  }

  /** A picture reached the page, before decoding. */
  receive(at: number, bytes: number): void {
    this.received.push({ at, bytes });
    trim(this.received, (entry) => entry.at, at - historyMs);
  }

  /** The decoder the view runs: hardware asked for, or the browser's default after that failed. */
  decoder(preference: "hardware" | "default", reason?: string): void {
    this.decoderChoice = { preference, ...(reason ? { reason } : {}) };
  }

  /** The view asked the daemon for a keyframe. */
  keyframeAsked(at: number): void {
    this.asked.push(at);
    trim(this.asked, (entry) => entry, at - historyMs);
  }

  /** The stats as of `now`; undefined before the first frame. */
  read(now: number): StreamStats | undefined {
    const last = this.frames.at(-1);
    if (!last) return undefined;
    const recent = this.frames.filter((frame) => frame.shownAt > now - windowMs);
    const arrived = this.received.filter((entry) => entry.at > now - windowMs);
    const first = this.frames[0];
    const spanned = first !== undefined && now - first.shownAt >= windowMs;
    const latencies = recent.map((frame) => frame.shownAt - frame.capturedAt);
    const latency = latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : undefined;
    const bytes = arrived.reduce((sum, entry) => sum + entry.bytes, 0);
    const shown = this.frames.filter((frame) => frame.shownAt > now - historyMs);
    let longestGapMs = shown.length ? now - (shown.at(-1)?.shownAt ?? now) : 0;
    for (let index = 1; index < shown.length; index++)
      longestGapMs = Math.max(
        longestGapMs,
        (shown[index]?.shownAt ?? 0) - (shown[index - 1]?.shownAt ?? 0),
      );
    const fps = spanned ? recent.length : undefined;
    return {
      fps,
      latencyMs:
        this.sameClock && latency !== undefined && latency >= 0 && latency < 10_000
          ? latency
          : undefined,
      receivedFps: arrived.length,
      megabits: Math.round((bytes * 8) / 1e4) / 100,
      longestGapMs: Math.round(longestGapMs),
      keyframesAsked: this.asked.filter((at) => at > now - historyMs).length,
      decoder: this.decoderChoice,
      still:
        fps !== undefined &&
        fps <= stillFps &&
        arrived.length > 0 &&
        bytes / arrived.length < stillBytes,
    };
  }
}

/** "H.264 · 59 fps · 35 ms", or "H.264 · still" while the screen holds still. */
export function streamSummary(stats: StreamStats | undefined): string[] {
  if (!stats) return [];
  return [
    "H.264",
    // A still screen sends no new frames; "0 fps" or "5 fps" would read as a broken stream.
    ...(stats.still ? ["still"] : stats.fps ? [`${stats.fps} fps`] : []),
    ...(stats.latencyMs === undefined ? [] : [`${stats.latencyMs} ms`]),
  ];
}

/**
 * The stats overlay's lines: what arrived, what was drawn, and the stalls between. A client that
 * knows where its decoder runs says so with `decoderLabel` (the phone's VideoToolbox does).
 */
export function streamDetails(
  stats: StreamStats | undefined,
  options: { decoderLabel?: string } = {},
): string[] {
  if (!stats) return ["Waiting for the first picture"];
  return [
    `Received ${stats.receivedFps}/s · drawn ${stats.fps ?? "–"}/s`,
    `${stats.megabits.toFixed(1)} Mbit/s`,
    `Longest stall ${stats.longestGapMs} ms (5 s)`,
    `Keyframes asked ${stats.keyframesAsked} (5 s)`,
    // WebCodecs takes a hardware hint but never says where a decode ran.
    options.decoderLabel
      ? `Decoder: ${options.decoderLabel}`
      : stats.decoder?.preference === "hardware"
        ? "Decoder: hardware asked for (unconfirmed)"
        : stats.decoder
          ? `Decoder: browser default${stats.decoder.reason ? ` (hardware failed: ${stats.decoder.reason})` : ""}`
          : "Decoder: not started",
  ];
}
