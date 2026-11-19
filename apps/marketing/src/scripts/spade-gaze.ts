/*
 * Where a drawn bot looks, and when it blinks: pure maths for scripts/spade-cast.ts. A look is
 * how far the pupils sit toward a point, each axis from -1 to 1, as the app's faces take it
 * (`--lx`, `--ly` on the face).
 */

export interface Gaze {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * The look toward `point` from a face drawn in `box`: the direction from the face's centre,
 * reaching full stretch once the point is two thirds of the face's size away, so a pointer
 * resting on the face itself barely moves the eyes.
 */
export function gazeToward(box: Box, point: { x: number; y: number }): Gaze {
  const size = Math.max(box.width, box.height, 1);
  const dx = (point.x - (box.left + box.width / 2)) / size;
  const dy = (point.y - (box.top + box.height / 2)) / size;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  const reach = Math.min(1, length * 1.5);
  return { x: round((dx / length) * reach), y: round((dy / length) * reach) };
}

/** A resting look written in the page as "x,y"; undefined for anything else. */
export function readGaze(text: string | null | undefined): Gaze | undefined {
  const parts = (text ?? "").split(",").map((part) => Number(part.trim()));
  const [x, y] = parts;
  if (parts.length !== 2 || x === undefined || y === undefined) return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: clamp(x), y: clamp(y) };
}

/** Milliseconds until a face's next blink, from a number in [0, 1): 2.6 to 5.8 seconds. */
export function blinkDelay(random: number): number {
  return Math.round(2600 + Math.max(0, Math.min(1, random)) * 3200);
}
