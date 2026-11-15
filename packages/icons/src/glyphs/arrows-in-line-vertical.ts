import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { arrow, smallHead } from "./arrow-up.ts";

/** Collapse: arrows from above and below closing on a line. */
export const ArrowsInLineVerticalIcon = /* @__PURE__ */ glyph("ArrowsInLineVertical", () => [
  ...arrow([12, 2.75], [12, 8.75], smallHead),
  line("M4 12h16"),
  ...arrow([12, 21.25], [12, 15.25], smallHead),
]);
