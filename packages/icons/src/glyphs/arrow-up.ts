import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { line } from "../parts.ts";

/** Send: an arrow up. */
export const ArrowUpIcon = /* @__PURE__ */ glyph("ArrowUp", () => [
  line("M12 19.5V5"),
  line(arrowhead([12, 5], -90, 6.25)),
]);
