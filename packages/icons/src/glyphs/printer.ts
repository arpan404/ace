import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, dot, line, shape } from "../parts.ts";

/** Print: a printer with a sheet going in at the top and one coming out below. */
export const PrinterIcon = /* @__PURE__ */ glyph("Printer", () => [
  line(
    polyline([
      [6.75, 7.5],
      [6.75, 3, 1.25],
      [17.25, 3, 1.25],
      [17.25, 7.5],
    ]),
  ),
  shape(
    polygon([
      [2.5, 7.5, 3],
      [21.5, 7.5, 3],
      [21.5, 17, 3],
      [17.25, 17, 0.6],
      [17.25, 21, 1.25],
      [6.75, 21, 1.25],
      [6.75, 17, 0.6],
      [2.5, 17, 3],
    ]),
  ),
  detail("M7.15 14h9.7"),
  dot(17.5, 10.75, 1.1),
]);
