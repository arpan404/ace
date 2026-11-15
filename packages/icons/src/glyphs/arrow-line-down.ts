import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { arrow } from "./arrow-up.ts";

/** Follow to the end: an arrow down onto a line. */
export const ArrowLineDownIcon = /* @__PURE__ */ glyph("ArrowLineDown", () => [
  ...arrow([12, 3.5], [12, 16]),
  line("M5 20.5h14"),
]);
