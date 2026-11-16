import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Write something new: a pencil over an open page. */
export const NotePencilIcon = /* @__PURE__ */ glyph("NotePencil", () => [
  line(
    polyline([
      [11, 4.5],
      [4.5, 4.5, 3.5],
      [4.5, 19.5, 3.5],
      [19.5, 19.5, 3.5],
      [19.5, 13],
    ]),
  ),
  shape(
    polygon([
      [10.2, 11.3, 0.6],
      [17.4, 4.1, 1.4],
      [19.9, 6.6, 1.4],
      [12.7, 13.8, 0.6],
      [9.6, 14.4, 0.4],
    ]),
  ),
  detail("M15.6 5.9l2.5 2.5"),
]);
