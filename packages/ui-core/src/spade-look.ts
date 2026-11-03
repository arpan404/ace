/**
 * The pure maths behind Spade's look. No DOM, no React: given a pointer and a mark rectangle,
 * where the pupils want to be, and keeping them inside the eye. Ported from the living
 * reference (`docs/design/spade/spade-mark.html`); the web app's mark and rail follow and the
 * marketing site all draw from here, so there is one geometry.
 */

/** A point in client pixels. */
export interface SpadePoint {
  x: number;
  y: number;
}

/** A mark rectangle in client pixels, as `getBoundingClientRect` reports it. */
export interface SpadeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the pupils look: the offset from the eye centre, in eye units. */
export interface SpadeLook {
  dx: number;
  dy: number;
}

/** A pupil ellipse. */
export interface SpadePupil {
  rx: number;
  ry: number;
}

/** Symmetric eyes, a touch below the middle; the whole face tilts -4° for character. */
export const spadeEyes = [
  { x: 8.7, y: 11.9 },
  { x: 15.3, y: 11.9 },
] as const;

export const spadeEye = { rx: 2.3, ry: 3.55 };

/** Where the pupils rest: low and a hair to the left. */
export const spadeRestLook: SpadeLook = { dx: -0.25, dy: 2 };

export const spadeTiltDeg = -4;

/** How far the pupils travel toward the pointer, in eye units. */
export const spadeMaxReach = 2;

/** The pupil size and edge pad the mark draws at `size`, small sizes included. */
export function spadePupilForSize(size: number): { pupil: SpadePupil; pad: number } {
  if (size <= 24) return { pupil: { rx: 1.25, ry: 1.8 }, pad: 0.02 };
  return { pupil: { rx: 1.1, ry: 1.6 }, pad: 0.22 };
}

/**
 * The look the pointer asks for: the direction from the mark's centre to the pointer,
 * rotated back by the face's tilt, scaled by distance (up to `spadeMaxReach`) so a near
 * pointer barely moves the pupils and a far one looks all the way. A degenerate rectangle
 * keeps the rest look.
 */
export function spadeLookFromPointer(rect: SpadeRect, pointer: SpadePoint): SpadeLook {
  if (!(rect.width > 0) || !(rect.height > 0)) return { ...spadeRestLook };
  const dx = (pointer.x - (rect.left + rect.width / 2)) / rect.width;
  const dy = (pointer.y - (rect.top + rect.height / 2)) / rect.height;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, len * 1.5);
  const tilt = (-spadeTiltDeg * Math.PI) / 180;
  const ux = dx / len;
  const uy = dy / len;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  return {
    dx: (ux * cos - uy * sin) * spadeMaxReach * k,
    dy: (ux * sin + uy * cos) * spadeMaxReach * k,
  };
}

/** The look kept inside the eye: scaled onto the ellipse the pupil may fill. */
export function clampSpadeLook(look: SpadeLook, pupil: SpadePupil, pad: number): SpadeLook {
  const ax = spadeEye.rx - pupil.rx - pad;
  const ay = spadeEye.ry - pupil.ry - pad;
  const reach = (look.dx * look.dx) / (ax * ax) + (look.dy * look.dy) / (ay * ay);
  if (reach <= 1) return { ...look };
  const scale = 1 / Math.sqrt(reach);
  return { dx: look.dx * scale, dy: look.dy * scale };
}

/** The pupil's centre: `look`, or the rest where none is given, kept inside the eye. */
export function spadePupilAt(
  centre: SpadePoint,
  pupil: SpadePupil,
  pad: number,
  look?: SpadeLook | undefined,
): SpadePoint {
  const clamped = clampSpadeLook(look ?? spadeRestLook, pupil, pad);
  return { x: centre.x + clamped.dx, y: centre.y + clamped.dy };
}

/** One easing step of the pupils toward their target, so they glide instead of jumping. */
export function approachSpadeLook(current: SpadeLook, target: SpadeLook, blend = 0.2): SpadeLook {
  return {
    dx: current.dx + (target.dx - current.dx) * blend,
    dy: current.dy + (target.dy - current.dy) * blend,
  };
}

/** Close enough to snap: the loop stops here, so nothing runs while the eyes rest. */
export function spadeLookSettled(current: SpadeLook, target: SpadeLook, epsilon = 0.01): boolean {
  return Math.abs(current.dx - target.dx) < epsilon && Math.abs(current.dy - target.dy) < epsilon;
}

const round = (value: number) => Number(value.toFixed(2));
const n = (value: number) => round(value).toString();

/** An egg-shaped SVG path: flatter on top, fuller below. Spade's eyes and their outlines. */
export function spadeEggPath(x: number, y: number, rx: number, ry: number): string {
  return (
    `M${n(x)} ${n(y - ry)}C${n(x + rx * 0.78)} ${n(y - ry)} ${n(x + rx)} ${n(y - ry * 0.36)} ${n(x + rx)} ${n(y + ry * 0.12)}` +
    `C${n(x + rx)} ${n(y + ry * 0.66)} ${n(x + rx * 0.58)} ${n(y + ry)} ${n(x)} ${n(y + ry)}` +
    `C${n(x - rx * 0.58)} ${n(y + ry)} ${n(x - rx)} ${n(y + ry * 0.66)} ${n(x - rx)} ${n(y + ry * 0.12)}` +
    `C${n(x - rx)} ${n(y - ry * 0.36)} ${n(x - rx * 0.78)} ${n(y - ry)} ${n(x)} ${n(y - ry)}Z`
  );
}

/** The eye outline's extra radius: thicker at small sizes so the face still reads. */
export function spadeRingForSize(size: number): number {
  return size <= 24 ? 1.15 : size <= 40 ? 0.85 : 0.62;
}
