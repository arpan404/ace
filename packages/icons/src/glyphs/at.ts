import { glyph } from "../glyph.ts";
import { circle, line } from "../parts.ts";

/** A mention: the at sign. */
export const AtIcon = /* @__PURE__ */ glyph("At", () => [
  line(circle(12, 12, 3.75)),
  line("M15.75 8.5v5.25a2.5 2.5 0 0 0 5 0V12a8.75 8.75 0 1 0-3.5 7"),
]);
