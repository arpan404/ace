import { glyph } from "../glyph.ts";
import { circle, line } from "../parts.ts";

/** A branch leaving the main line. */
export const GitBranchIcon = /* @__PURE__ */ glyph("GitBranch", () => [
  line(circle(6.5, 5.5, 2.5)),
  line(circle(6.5, 18.5, 2.5)),
  line(circle(17.5, 5.5, 2.5)),
  line("M6.5 8v8"),
  line("M17.5 8c0 4.5-11 3.25-11 8"),
]);
