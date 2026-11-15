import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { circle, line } from "../parts.ts";

/** A fork: two lines growing from one. */
export const GitForkIcon = /* @__PURE__ */ glyph("GitFork", () => [
  line(circle(6.5, 5.5, 2.5)),
  line(circle(17.5, 5.5, 2.5)),
  line(circle(12, 18.5, 2.5)),
  line(
    polyline([
      [6.5, 8],
      [6.5, 12, 3],
      [17.5, 12, 3],
      [17.5, 8],
    ]),
  ),
  line("M12 12v4"),
]);
