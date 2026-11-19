import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { line } from "../parts.ts";

/** Down, or lower (a rank falling): an arrow down, the mirror of ArrowUp. */
export const ArrowDownIcon = /* @__PURE__ */ glyph("ArrowDown", () => [
  line("M12 4.5V19"),
  line(arrowhead([12, 19], 90, 6.25)),
]);
