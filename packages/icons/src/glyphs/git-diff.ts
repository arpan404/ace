import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Changes: lines added and removed, on a page. */
export const GitDiffIcon = /* @__PURE__ */ glyph("GitDiff", () => [
  shape(rect(4, 2.5, 16, 19, 4.5)),
  detail("M12 6.75v5.5M9.25 9.5h5.5"),
  detail("M9.25 16.25h5.5"),
]);
