import { glyph } from "../glyph.ts";
import { arc, arrowhead, onCircle } from "../geometry.ts";
import { line } from "../parts.ts";

/** Undo, or reset: an arrow turning counter-clockwise. */
export const ArrowCounterClockwiseIcon = /* @__PURE__ */ glyph("ArrowCounterClockwise", () => [
  line(arc(12, 12, 8, 162, -140)),
  line(arrowhead(onCircle(12, 12, 8, -140), 130, 4)),
]);
