import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { square } from "./square.ts";

/** Side by side: a square split into left and right. */
export const SquareSplitHorizontalIcon = /* @__PURE__ */ glyph("SquareSplitHorizontal", () => [
  square(),
  detail("M12 4.1v15.8"),
]);
