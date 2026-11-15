import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** A game: a controller with its pad and two buttons. */
export const GameControllerIcon = /* @__PURE__ */ glyph("GameController", () => [
  shape(
    polygon([
      [6.25, 6, 3.25],
      [17.75, 6, 3.25],
      [21.75, 17.25, 2.5],
      [17.5, 19.25, 2],
      [14.75, 15.75, 1.5],
      [9.25, 15.75, 1.5],
      [6.5, 19.25, 2],
      [2.25, 17.25, 2.5],
    ]),
  ),
  detail("M6.25 11h3.5M8 9.25v3.5"),
  dot(15, 12, 1.1),
  dot(17.25, 9.75, 1.1),
]);
