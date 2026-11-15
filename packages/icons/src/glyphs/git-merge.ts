import { glyph } from "../glyph.ts";
import { circle, line } from "../parts.ts";

/** Merged: a branch joining back into another. */
export const GitMergeIcon = /* @__PURE__ */ glyph("GitMerge", () => [
  line(circle(6.5, 5.5, 2.5)),
  line(circle(6.5, 18.5, 2.5)),
  line(circle(17.5, 16.5, 2.5)),
  line("M6.5 8v8"),
  line("M6.5 8c0 5 3.75 8.5 8.5 8.5"),
]);
