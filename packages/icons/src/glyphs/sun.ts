import { glyph } from "../glyph.ts";
import { onCircle } from "../geometry.ts";
import { circle, line, shape } from "../parts.ts";

/** Light mode: a sun with eight short rays. */
export const SunIcon = /* @__PURE__ */ glyph("Sun", () => {
  let rays = "";
  for (let k = 0; k < 8; k++) {
    const [x1, y1] = onCircle(12, 12, 7.25, k * 45);
    const [x2, y2] = onCircle(12, 12, 9.25, k * 45);
    rays += `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return [shape(circle(12, 12, 4)), line(rays)];
});
