import { glyph } from "../glyph.ts";
import { onCircle, polyline } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

const cx = 12;
const cy = 13.25;
const r = 9.25;
const at = ([x, y]: readonly [number, number]) => `${x.toFixed(2)} ${y.toFixed(2)}`;

/** Effort, or a usage limit: a dial with its needle swung far to the right. */
export const GaugeIcon = /* @__PURE__ */ glyph("Gauge", () => {
  // A dial cut off flat at the bottom, its two lower corners rounded.
  const left = onCircle(cx, cy, r, 150);
  const right = onCircle(cx, cy, r, 30);
  const leftOn = onCircle(cx, cy, r, 140);
  const rightOn = onCircle(cx, cy, r, 40);
  const y = left[1];
  const dial =
    `M${at(leftOn)}A${r} ${r} 0 1 1 ${at(rightOn)}` +
    `Q${at(right)} ${at([right[0] - 1.6, y])}` +
    `H${(left[0] + 1.6).toFixed(2)}` +
    `Q${at(left)} ${at(leftOn)}Z`;
  return [shape(dial), detail(polyline([[cx, cy + 1.5], onCircle(cx, cy + 1.5, 6, -38)]))];
});
