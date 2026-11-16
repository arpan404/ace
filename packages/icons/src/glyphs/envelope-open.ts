import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Read: an open envelope with its letter standing out of it. */
export const EnvelopeOpenIcon = /* @__PURE__ */ glyph("EnvelopeOpen", () => [
  line(
    polyline([
      [6.75, 11.8],
      [6.75, 3.25, 1.75],
      [17.25, 3.25, 1.75],
      [17.25, 11.8],
    ]),
  ),
  shape(
    polygon([
      [3, 8.75, 1.5],
      [12, 14.75, 1.2],
      [21, 8.75, 1.5],
      [21, 20, 3.5],
      [3, 20, 3.5],
    ]),
  ),
]);
