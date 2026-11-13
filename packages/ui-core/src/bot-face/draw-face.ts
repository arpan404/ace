import type { BotFace } from "./model.ts";
import { BODIES } from "./draw-bodies.ts";
import { drawCheeks, drawEyes, drawMouth, drawStateExtras } from "./draw-features.ts";
import { EARS, MARKINGS, drawAccessory, topMarkings } from "./draw-parts.ts";
import { PAPER, eyeGeometry, faceTier, n, type FaceTier } from "./draw-shared.ts";
import { faceColours, type FaceColours, type FaceScheme } from "./palette.ts";

/** The whole face tilts a little, as Spade's mark does. */
export const botFaceTiltDeg = -4;

/**
 * A face's SVG content for a `viewBox="0 0 24 24"` box at `size` px. `uid` makes its clip ids
 * unique on the page (letters, digits, `-` and `_` only). The motion sheet animates the classes
 * inside; the state goes on the `<svg>` as `data-state`.
 */
export function botFaceMarkup(face: BotFace, size: number, uid: string): string {
  const t = faceTier(size);
  const body = BODIES[face.body];
  const clip = `${uid}b`;
  const shapes = body.shapes(t);
  const ears = face.ears === "none" ? undefined : EARS[face.ears];
  const offset = t === "s" ? [-0.35, -0.8] : [-0.6, -1.05];
  const light =
    t === "s"
      ? ""
      : `<ellipse cx="${body.light[0]}" cy="${body.light[1]}" rx="${t === "l" ? 2.6 : 2.2}" ry="${t === "l" ? 1.25 : 1.05}" transform="rotate(-32 ${body.light[0]} ${body.light[1]})" fill="${PAPER}" opacity=".26"/>`;
  const volume =
    `<g data-part="body"><g fill="var(--bs)">${shapes}</g>` +
    `<g clip-path="url(#${clip})"><g fill="var(--b)" transform="translate(${offset[0]} ${offset[1]})">${shapes}</g></g>${light}</g>`;
  // Ears and top markings are drawn for the round head (top at y 1.4) and follow each body's top.
  const topDy = n(body.top[1] - 1.4);
  const eyes = eyeGeometry(face.eyes, size, body);
  const marking =
    face.marking === "none"
      ? ""
      : `<g clip-path="url(#${clip})" data-part="marking"><g transform="translate(0 ${topMarkings.has(face.marking) ? topDy : 0})">${MARKINGS[face.marking](t, eyes, body)}</g></g>`;
  return (
    `<defs><clipPath id="${clip}">${shapes}</clipPath></defs>` +
    `<g transform="rotate(${botFaceTiltDeg} 12 12)"><g class="bf-hd">` +
    (ears ? `<g data-part="ears" transform="translate(0 ${topDy})">${ears.back(t)}</g>` : "") +
    (body.back ? `<g data-part="body">${body.back(t)}</g>` : "") +
    drawAccessory(face, size, body, "back", clip) +
    volume +
    (ears ? `<g data-part="ears" transform="translate(0 ${topDy})">${ears.inner(t)}</g>` : "") +
    (body.front ? `<g data-part="body">${body.front(t, clip)}</g>` : "") +
    marking +
    drawAccessory(face, size, body, "front", clip) +
    drawCheeks(face, size, body) +
    drawEyes(face, size, body, uid) +
    (body.over ? `<g data-part="body">${body.over(t)}</g>` : "") +
    drawMouth(face, size, body) +
    drawAccessory(face, size, body, "over", clip) +
    drawStateExtras(size, body) +
    `</g></g>`
  );
}

const roles: readonly (readonly [keyof FaceColours, string])[] = [
  ["body", "b"],
  ["accent", "a"],
  ["bodyShade", "bs"],
  ["accentShade", "as"],
  ["pale", "bl"],
  ["visor", "visor"],
  ["mask", "mask"],
  ["blush", "blush"],
  ["tongue", "tongue"],
];

/**
 * The colour roles the markup reads, for both schemes: `--<role>-dark` and `--<role>-light`.
 * A sheet then sets `--<role>` from the one that matches the page.
 */
export function botFaceColourVars(face: BotFace): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scheme of ["dark", "light"] as const satisfies readonly FaceScheme[]) {
    const colours = faceColours(face.pair, scheme);
    for (const [key, role] of roles) out[`--${role}-${scheme}`] = colours[key];
  }
  return out;
}

export type { FaceTier };
export { faceTier };
