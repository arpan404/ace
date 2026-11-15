import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { arrow, smallHead } from "./arrow-up.ts";

/** Expand: arrows leaving a line, up and down. */
export const ArrowsOutLineVerticalIcon = /* @__PURE__ */ glyph("ArrowsOutLineVertical", () => [
  ...arrow([12, 8.75], [12, 2.75], smallHead),
  line("M4 12h16"),
  ...arrow([12, 15.25], [12, 21.25], smallHead),
]);
