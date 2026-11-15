import { glyph } from "../glyph.ts";
import { circle, line, shape, type Part } from "../parts.ts";

const r = 2.25;
const slider = (y: number, x: number): Part[] => [
  line(`M3.5 ${y}H${x - r}M${x + r} ${y}H20.5`),
  shape(circle(x, y, r)),
];

/** Settings to tune: three sliders. */
export const SlidersHorizontalIcon = /* @__PURE__ */ glyph("SlidersHorizontal", () => [
  ...slider(5.5, 15),
  ...slider(12, 8.5),
  ...slider(18.5, 13.5),
]);
