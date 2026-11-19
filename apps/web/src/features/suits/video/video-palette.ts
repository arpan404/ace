import type { SuitVideo } from "@ace/protocol/suits";
import { easeColour, strongestColour, tintedVeil, videoAccent } from "@ace/suits";
import type { Palette, Scheme } from "@ace/themes";

/*
 * ace's colours following a Suit's video (ADR 0169). Twice a second while it plays, the frame is
 * read as a 16 × 9 grid; its strongest colour, eased so a cut doesn't flash, becomes the accent
 * tokens and the veil's tint. Only those tokens are written: status colours, the danger fill and
 * every protected part keep ace's own. Under Reduce motion one colour is taken and held. A frame
 * the page can't read (no CORS) leaves the Suit's own colours.
 */

export const paletteColumns = 16;
export const paletteRows = 9;
export const paletteEveryMs = 500;
/** How far each sample moves the colour toward the frame's. */
const ease = 0.35;

/** The tokens the sampler may set: the accent family and the veil over the video. */
export const videoTokenNames = [
  "--ring",
  "--ring-hover",
  "--ring-pressed",
  "--ring-foreground",
  "--ring-text",
  "--focus",
  "--accent-theme",
  "--suit-video-veil",
] as const;
export type VideoTokens = Partial<Record<(typeof videoTokenNames)[number], string>>;

/** The tokens for one picked colour on the Suit's palette, as `palette` in suit.json allows. */
export function videoTokens(input: {
  colour: string;
  scheme: Scheme;
  palette: Palette;
  follow: SuitVideo["palette"];
  /** `--suit-app-reveal`: how much of the video the veil lets through. */
  reveal: number;
}): VideoTokens {
  const { colour, scheme, palette, follow } = input;
  const tokens: VideoTokens = {};
  if (follow.accent) {
    const accent = videoAccent(colour, scheme, palette);
    tokens["--ring"] = accent.accent;
    tokens["--ring-hover"] = accent.accentHover;
    tokens["--ring-pressed"] = accent.accentPressed;
    tokens["--ring-foreground"] = accent.accentFg;
    tokens["--ring-text"] = accent.accentText;
    tokens["--focus"] =
      `color-mix(in srgb, ${accent.accent} ${palette.material.focus}%, transparent)`;
    tokens["--accent-theme"] = accent.accent;
  }
  if (follow.tint > 0)
    tokens["--suit-video-veil"] = tintedVeil({
      surface: palette.sidebar,
      text: palette.t1,
      colour,
      tint: follow.tint,
      reveal: input.reveal,
    });
  return tokens;
}

export interface PaletteSamplerOptions {
  /** The frame as RGBA, `paletteColumns × paletteRows`; throws when it can't be read. */
  read(): ArrayLike<number> | undefined;
  /** The colour to show now; undefined puts the Suit's own colours back. */
  show(colour: string | undefined): void;
  after(ms: number, run: () => void): () => void;
}

export interface PaletteSampler {
  /** Sample on a beat while the video plays; `still` takes one colour and holds it. */
  run(mode: "playing" | "still" | "paused"): void;
  dispose(): void;
}

const noop = () => {};

export function createPaletteSampler(options: PaletteSamplerOptions): PaletteSampler {
  let colour: string | undefined;
  let mode: "playing" | "still" | "paused" = "paused";
  let unreadable = false;
  let disposed = false;
  let cancel = noop;

  const sample = (): boolean => {
    let pixels: ArrayLike<number> | undefined;
    try {
      pixels = options.read();
    } catch {
      // A tainted frame never becomes readable: stop for this video.
      unreadable = true;
      cancel();
      if (colour !== undefined) options.show((colour = undefined));
      return false;
    }
    if (!pixels) return false;
    const picked = strongestColour(pixels);
    if (picked === undefined) return true;
    const next = mode === "still" ? picked : easeColour(colour, picked, ease);
    if (next !== colour) options.show((colour = next));
    return true;
  };

  const beat = () => {
    cancel = options.after(paletteEveryMs, () => {
      if (disposed || mode !== "playing" || unreadable) return;
      sample();
      if (!unreadable) beat();
    });
  };

  return {
    run(next) {
      if (disposed || unreadable) return;
      const was = mode;
      mode = next;
      cancel();
      if (next === "playing") {
        if (was !== "playing") sample();
        if (!unreadable) beat();
      } else if (next === "still") {
        // One frame's colour, taken now and held; tried again on a later call until it reads.
        sample();
      }
    },
    dispose() {
      disposed = true;
      cancel();
      if (colour !== undefined) options.show(undefined);
    },
  };
}
