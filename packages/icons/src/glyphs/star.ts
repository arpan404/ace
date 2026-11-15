import { glyph } from "../glyph.ts";
import { onCircle, polygon, type Vertex } from "../geometry.ts";
import { shape } from "../parts.ts";

/** A favourite: a five-pointed star with soft points. */
export const StarIcon = /* @__PURE__ */ glyph("Star", () => {
  const points: Vertex[] = [];
  for (let i = 0; i < 10; i++) {
    const [x, y] = onCircle(12, 12.75, i % 2 ? 4.6 : 9.75, -90 + i * 36);
    points.push([x, y, i % 2 ? 0.6 : 1.3]);
  }
  return [shape(polygon(points))];
});
