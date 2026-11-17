import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** A Suit, a look for ace: a coat hanger on its hook. */
export const CoatHangerIcon = /* @__PURE__ */ glyph("CoatHanger", () => [
  line("M12 9.75V8.9c0-.8.55-1.25 1.2-1.75A2.5 2.5 0 1 0 9.5 5.5"),
  shape(
    polygon([
      [12, 9.75, 0.8],
      [21.25, 16.5, 1.75],
      [20, 19, 1.75],
      [4, 19, 1.75],
      [2.75, 16.5, 1.75],
    ]),
  ),
]);
