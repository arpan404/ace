/*
 * When ace-media re-encodes a Simulator's picture for a viewer (E3b, in `media-vt`), and at what
 * size. Pure.
 */

/**
 * The least serve-sim sends while the screen is busy (its documented default is 6 to 30 Mbit/s
 * by screen size). Until a busier rate has been measured, a viewer is judged against this.
 */
export const simulatorSourceFloor = 6_000_000;
/** Below this share of the source's rate a viewer can't carry it: ace-media re-encodes for it. */
const transcodeBelow = 5 / 6;
/** And at or above this share, serve-sim's own stream passes through again (hysteresis). */
const passThroughFrom = 5.5 / 6;

/**
 * Whether a Simulator live view needs its picture re-encoded: its link can't carry serve-sim's
 * stream (`source`, the measured busy rate, never below the 6 Mbit/s floor), or its panel is
 * smaller than the Simulator's native picture (an iPad on a phone). `transcoding` is the current
 * state, so the rate has some room before it flips back.
 */
export function simulatorNeedsTranscode(input: {
  transcoding: boolean;
  bitrate: number;
  box: { maxWidth: number; maxHeight: number };
  native: { width: number; height: number } | undefined;
  /** serve-sim's busiest recent rate in bit/s, as measured; the floor when unknown. */
  source?: number | undefined;
}): boolean {
  const larger =
    input.native !== undefined &&
    (input.native.width > input.box.maxWidth || input.native.height > input.box.maxHeight);
  if (larger) return true;
  const source = Math.max(simulatorSourceFloor, input.source ?? 0);
  return input.bitrate < source * (input.transcoding ? passThroughFrom : transcodeBelow);
}

/** The largest even size at or below `value`, as every hardware encoder takes. */
const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/**
 * The encode ace-media re-encodes a Simulator at for a viewer (E3b, the `--transcode`
 * replacement): serve-sim's native picture fitted inside the viewer's box at its aspect, never
 * larger than native, even sides, at the viewer's bit rate.
 */
export function simulatorEncodeSpec(
  native: { width: number; height: number },
  settings: { maxWidth: number; maxHeight: number; bitrate: number },
): { id: number; codec: string; width: number; height: number; fps: number; bitrate: number } {
  const fit = Math.min(1, settings.maxWidth / native.width, settings.maxHeight / native.height);
  return {
    id: 1,
    codec: "avc1.640033",
    width: even(native.width * fit),
    height: even(native.height * fit),
    fps: 60,
    bitrate: settings.bitrate,
  };
}
