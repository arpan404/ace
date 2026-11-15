import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { square } from "./square.ts";

/** One above the other: a square split into top and bottom. */
export const SquareSplitVerticalIcon = /* @__PURE__ */ glyph("SquareSplitVertical", () => [
  square(),
  detail("M4.1 12h15.8"),
]);
