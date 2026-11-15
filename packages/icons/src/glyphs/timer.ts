import { glyph } from "../glyph.ts";
import { arc, arrowhead, onCircle, polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Automations: a clock inside a repeat arrow, for work that runs again on a schedule. */
export const TimerIcon = /* @__PURE__ */ glyph("Timer", () => [
  line(arc(12, 12, 8.75, 18, 318)),
  line(arrowhead(onCircle(12, 12, 8.75, 318), 48, 4)),
  line(
    polyline([
      [12, 8],
      [12, 12, 0.8],
      [14.75, 13.75],
    ]),
  ),
]);
