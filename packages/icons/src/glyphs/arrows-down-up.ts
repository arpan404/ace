import { glyph } from "../glyph.ts";
import { arrow, smallHead } from "./arrow-up.ts";

/** Sort order: an arrow down beside an arrow up. */
export const ArrowsDownUpIcon = /* @__PURE__ */ glyph("ArrowsDownUp", () => [
  ...arrow([7.5, 4], [7.5, 20], smallHead),
  ...arrow([16.5, 20], [16.5, 4], smallHead),
]);
