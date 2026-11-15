import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { square } from "./check-square.ts";

/** Close a tab or panel: a cross in a square. */
export const XSquareIcon = /* @__PURE__ */ glyph("XSquare", () => [
  square(),
  detail("M9 9l6 6M15 9l-6 6"),
]);
