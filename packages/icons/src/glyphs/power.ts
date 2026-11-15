import { glyph } from "../glyph.ts";
import { arc } from "../geometry.ts";
import { line } from "../parts.ts";

/** Power: a broken ring with a stroke through its gap. */
export const PowerIcon = /* @__PURE__ */ glyph("Power", () => [
  line(arc(12, 12.75, 8.5, -52, 232)),
  line("M12 2.75v8.5"),
]);
