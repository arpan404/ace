import { glyph } from "../glyph.ts";
import { arrowhead, polyline } from "../geometry.ts";
import { circle, line } from "../parts.ts";

/** Changes: two nodes, each sending an arrow across to the other's side. */
export const GitDiffIcon = /* @__PURE__ */ glyph("GitDiff", () => [
  line(circle(6, 18.5, 2.5)),
  line(circle(18, 5.5, 2.5)),
  line(
    polyline([
      [6, 16],
      [6, 6, 3.5],
      [12.5, 6],
    ]),
  ),
  line(arrowhead([12.5, 6], 0, 3.2)),
  line(
    polyline([
      [18, 8],
      [18, 18, 3.5],
      [11.5, 18],
    ]),
  ),
  line(arrowhead([11.5, 18], 180, 3.2)),
]);
