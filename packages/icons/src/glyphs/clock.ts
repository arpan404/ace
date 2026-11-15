import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { circle, detail, shape, type Part } from "../parts.ts";

/** The clock's round face; also the base of the countdown clock. */
export const clockFace = (): Part => shape(circle(12, 12, 9.25));

/** The clock's two hands, pivoting at `cx`, `cy`. */
export const clockHands = (cx = 12, cy = 12): Part =>
  detail(
    polyline([
      [cx, cy - 4.5],
      [cx, cy, 0.8],
      [cx + 3, cy + 2],
    ]),
  );

/** A time: a clock face. */
export const ClockIcon = /* @__PURE__ */ glyph("Clock", () => [clockFace(), clockHands()]);
