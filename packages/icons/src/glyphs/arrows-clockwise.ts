import { glyph } from "../glyph.ts";
import { arc, arrowhead, onCircle } from "../geometry.ts";
import { line } from "../parts.ts";

/** Refresh, or reconnect: two arrows chasing each other round. */
export const ArrowsClockwiseIcon = /* @__PURE__ */ glyph("ArrowsClockwise", () => [
  line(arc(12, 12, 8, 195, 320)),
  line(arrowhead(onCircle(12, 12, 8, 320), 50, 4)),
  line(arc(12, 12, 8, 15, 140)),
  line(arrowhead(onCircle(12, 12, 8, 140), 230, 4)),
]);
