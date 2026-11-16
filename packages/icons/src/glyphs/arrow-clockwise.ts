import { glyph } from "../glyph.ts";
import { arc, arrowhead, onCircle } from "../geometry.ts";
import { line } from "../parts.ts";

/** Retry: an arrow turning clockwise. */
export const ArrowClockwiseIcon = /* @__PURE__ */ glyph("ArrowClockwise", () => [
  line(arc(12, 12, 8, 18, 320)),
  line(arrowhead(onCircle(12, 12, 8, 320), 50, 4)),
]);
