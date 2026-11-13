import { faceInk, facePaper } from "./palette.ts";
import type { BotFaceValue } from "./model.ts";

/*
 * Shared pieces of the face geometry. Everything draws in a 24-unit box (Spade's round head is
 * r 10.6 at 12, 12) as SVG markup strings, so a native client can port the same numbers.
 * Colours are roles, not values: `var(--b)` body, `--a` accent, `--bs`/`--as` their shades,
 * `--bl` pale, `--visor`, `--mask`, `--blush`, `--tongue`; the renderer sets them per pair.
 */

export const INK = faceInk;
export const PAPER = facePaper;

/** Size tiers: s ≤ 24 px, m ≤ 40 px, l above. */
export type FaceTier = "s" | "m" | "l";

export function faceTier(size: number): FaceTier {
  return size <= 24 ? "s" : size <= 40 ? "m" : "l";
}

/** Eye outline width per tier: thicker when small so the eyes still read. */
export const RING: Record<FaceTier, number> = { s: 1.15, m: 0.85, l: 0.62 };
/** Line mouths' stroke per tier. */
export const LINE: Record<FaceTier, number> = { s: 1.4, m: 1.1, l: 0.9 };

/** A number for markup: two decimals at most. */
export const n = (value: number) => String(Math.round(value * 100) / 100);

/** The egg the eyes are drawn from: wider below, as Spade's own. */
export function egg(x: number, y: number, rx: number, ry: number): string {
  return (
    `M${n(x)} ${n(y - ry)}C${n(x + rx * 0.78)} ${n(y - ry)} ${n(x + rx)} ${n(y - ry * 0.36)} ${n(x + rx)} ${n(y + ry * 0.12)}` +
    `C${n(x + rx)} ${n(y + ry * 0.66)} ${n(x + rx * 0.58)} ${n(y + ry)} ${n(x)} ${n(y + ry)}` +
    `C${n(x - rx * 0.58)} ${n(y + ry)} ${n(x - rx)} ${n(y + ry * 0.66)} ${n(x - rx)} ${n(y + ry * 0.12)}` +
    `C${n(x - rx)} ${n(y - ry * 0.36)} ${n(x - rx * 0.78)} ${n(y - ry)} ${n(x)} ${n(y - ry)}Z`
  );
}

/** An eye shape: half spacing, radii, resting lid (0 open), vertical nudge. */
export interface EyeShape {
  dx: number;
  rx: number;
  ry: number;
  lid: number;
  dy: number;
}

export const EYES: Record<BotFaceValue<"eyes">, EyeShape> = {
  egg: { dx: 3.3, rx: 2.3, ry: 3.55, lid: 0, dy: 0 },
  round: { dx: 3.5, rx: 2.7, ry: 2.8, lid: 0, dy: 0.3 },
  big: { dx: 3.55, rx: 2.8, ry: 3.95, lid: 0, dy: -0.2 },
  sleepy: { dx: 3.3, rx: 2.4, ry: 3.4, lid: 0.38, dy: 0 },
  almond: { dx: 3.6, rx: 2.65, ry: 2.6, lid: 0.24, dy: 0.2 },
  bead: { dx: 3.1, rx: 1.8, ry: 2.35, lid: 0, dy: 0.6 },
};

/** A body: its silhouette, where the face sits on it, and any parts of its own. */
export interface BodyShape {
  shapes(tier: FaceTier): string;
  eyeY: number;
  eyeScale?: number;
  mouthY: number;
  /** Top centre: where ears, hats and top markings sit. */
  top: readonly [number, number];
  left: number;
  right: number;
  cheekY: number;
  cheekDx: number;
  /** Where the top light sits. */
  light: readonly [number, number];
  /** The lid colour, when not the body's. */
  lid?: string;
  /** Drawn behind the body, in front of it (`clip`: the silhouette's clip id), over the eyes. */
  back?(tier: FaceTier): string;
  front?(tier: FaceTier, clip: string): string;
  over?(tier: FaceTier): string;
  /** `none`: the body has no mouth (a bird's beak stands in). */
  mouth?: "none";
}

/** Where the eyes sit on a body, at a size. */
export interface EyeGeometry {
  shape: EyeShape;
  tier: FaceTier;
  pupil: { rx: number; ry: number };
  /** How far the pupil may travel inside the eye. */
  reach: { x: number; y: number };
  y: number;
  xs: readonly [number, number];
}

export function eyeGeometry(
  eyes: BotFaceValue<"eyes">,
  size: number,
  body: BodyShape,
): EyeGeometry {
  const shape = EYES[eyes];
  const tier = faceTier(size);
  const small = tier === "s";
  const k = body.eyeScale ?? 1;
  const pupil = { rx: shape.rx * (small ? 0.56 : 0.5), ry: shape.ry * (small ? 0.52 : 0.47) };
  const pad = small ? 0.02 : 0.22;
  return {
    shape,
    tier,
    pupil,
    reach: {
      x: Math.max(0.3, shape.rx - pupil.rx - pad),
      y: Math.max(0.3, shape.ry - pupil.ry - pad),
    },
    y: body.eyeY + shape.dy,
    xs: [12 - shape.dx * k, 12 + shape.dx * k],
  };
}
