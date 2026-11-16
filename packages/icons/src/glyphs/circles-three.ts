import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Thread details: a card of lines, the thread's facts listed. */
export const CirclesThreeIcon = /* @__PURE__ */ glyph("CirclesThree", () => [
  shape(rect(3.5, 3, 17, 18, 5)),
  detail("M8 8.5h8M8 12h8M8 15.5h5"),
]);
