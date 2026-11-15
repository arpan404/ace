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
  /** A band cut out of this part alone: `path` stroked `width` wide (the gap beside an "off" slash). */
  gap?: { path: string; width: number };
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

/** The diagonal every "off" icon is crossed by, top left to bottom right. */
const slashPath = "M3.75 3.75 20.25 20.25";

/**
 * The icon turned off (muted, hidden, unpinned): crossed by a slash, with a clear gap cut out of
 * the drawing on both sides of it so the two read apart at 14 px.
 */
export function slashed(parts: readonly Part[]): Part[] {
  const gap = { path: "M3 2.25 21.75 21", width: 4.75 };
  return [...parts.map((part) => ({ ...part, gap })), line(slashPath)];
}

/** Where the "new" plus sits: the lower right corner. */
const plusAt = circle(18, 18, 3.75);

/** The icon with a plus in its lower right corner, cut clear of the drawing: make a new one. */
export function plussed(parts: readonly Part[]): Part[] {
  const hole = circle(plusAt.cx, plusAt.cy, plusAt.r + 2.6);
  const { cx, cy, r } = plusAt;
  return [
    ...parts.map((part) => ({ ...part, hole })),
    line(`M${cx} ${cy - r}v${r * 2}M${cx - r} ${cy}h${r * 2}`),
  ];
}
/** A round dot, sized to sit with a 1.75 stroke. */
export const dot = (cx: number, cy: number, r = 1.4): Part => spot(circle(cx, cy, r));
