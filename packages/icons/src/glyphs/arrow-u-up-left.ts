import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { line } from "../parts.ts";
import { fullHead } from "./arrow-up.ts";

/** Back: an arrow that makes a U-turn to the left. */
export const ArrowUUpLeftIcon = /* @__PURE__ */ glyph("ArrowUUpLeft", () => [
  line("M4.5 9H14.75A5.25 5.25 0 0 1 14.75 19.5H9"),
  line(arrowhead([4.5, 9], 180, fullHead)),
]);
