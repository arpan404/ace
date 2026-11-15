import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Logs: a scroll, rolled at top and bottom. */
export const ScrollIcon = /* @__PURE__ */ glyph("Scroll", () => [
  shape(rect(3.5, 2.75, 17, 4.5, 2.25)),
  line("M6 7.25v9.5M18 7.25v9.5M9.25 10.5h5.5M9.25 13.5h3.5"),
  shape(rect(3.5, 16.75, 17, 4.5, 2.25)),
]);
