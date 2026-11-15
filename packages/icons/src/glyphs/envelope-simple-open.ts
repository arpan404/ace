import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Read: an envelope with its flap open. */
export const EnvelopeSimpleOpenIcon = /* @__PURE__ */ glyph("EnvelopeSimpleOpen", () => [
  shape(
    polygon([
      [3, 9.5, 2],
      [12, 3.25, 1.5],
      [21, 9.5, 2],
      [21, 20, 3.5],
      [3, 20, 3.5],
    ]),
  ),
  detail(
    polyline([
      [3.5, 10.25],
      [12, 15.5, 1],
      [20.5, 10.25],
    ]),
  ),
]);
