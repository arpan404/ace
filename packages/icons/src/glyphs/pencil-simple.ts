import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Edit: a pencil. */
export const PencilSimpleIcon = /* @__PURE__ */ glyph("PencilSimple", () => [
  shape(
    polygon([
      [4, 20, 0.6],
      [4.6, 16.2, 0.6],
      [15.6, 5.2, 2.2],
      [18.8, 8.4, 2.2],
      [7.8, 19.4, 0.6],
    ]),
  ),
  detail("M13.25 7.5l3.25 3.25"),
]);
