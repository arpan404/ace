import { glyph } from "../glyph.ts";
import { polygon, polyline, turned, type Vertex } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Upright, then leaned so the handle points to the upper right. */
const lean = (points: readonly Vertex[]) => turned(points, 40, 12, 13);

/** Clear out: a broom, leaning with its handle to the upper right. */
export const BroomIcon = /* @__PURE__ */ glyph("Broom", () => [
  line(
    polyline(
      lean([
        [12, 1],
        [12, 10],
      ]),
    ),
  ),
  shape(
    polygon(
      lean([
        [8.5, 10, 1.75],
        [15.5, 10, 1.75],
        [18, 21.5, 1.25],
        [6, 21.5, 1.25],
      ]),
    ),
  ),
  detail(
    polyline(
      lean([
        [10, 16.75],
        [9.6, 21],
      ]),
    ) +
      polyline(
        lean([
          [14, 16.75],
          [14.4, 21],
        ]),
      ),
  ),
]);
