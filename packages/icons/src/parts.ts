/**
 * What a glyph is made of. Each part has a role that decides how each weight paints it, so one
 * drawing gives every weight:
 *
 * - `shape`: the icon's body. A stroke in outline, tinted in two-tone, solid when filled.
 * - `detail`: marks inside the body (a check, a prompt). A stroke, cut out of the solid body.
 * - `line`: strokes outside any body (a handle, a cable). A stroke in every weight.
 * - `spot`: small solid marks (eyes, dots). Solid in outline and two-tone, cut out of the solid body.
 */
export type Role = "shape" | "detail" | "line" | "spot";

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** Path data, or a circle. */
export type Outline = string | Circle;

export interface Part {
  role: Role;
  outline: Outline;
  /** Drawn as eight dashes (the "working" ring). Circles only. */
  dashed?: boolean;
  /** A circle cut out of this part alone, so it can tuck behind another. */
  hole?: Circle;
}

export const circle = (cx: number, cy: number, r: number): Circle => ({ cx, cy, r });

export const shape = (outline: Outline, extra: Partial<Pick<Part, "hole">> = {}): Part => ({
  role: "shape",
  outline,
  ...extra,
});
export const detail = (outline: Outline): Part => ({ role: "detail", outline });
export const line = (
  outline: Outline,
  extra: Partial<Pick<Part, "dashed" | "hole">> = {},
): Part => ({
  role: "line",
  outline,
  ...extra,
});
export const spot = (outline: Outline): Part => ({ role: "spot", outline });
/** A round dot, sized to sit with a 1.75 stroke. */
export const dot = (cx: number, cy: number, r = 1.4): Part => spot(circle(cx, cy, r));
