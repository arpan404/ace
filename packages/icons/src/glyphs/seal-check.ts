import { glyph } from "../glyph.ts";
import { onCircle, polygon, polyline, type Vertex } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Twelve soft scallops around the centre: a rosette's edge. */
const scallops = (): Vertex[] =>
  Array.from({ length: 24 }, (_, i): Vertex => {
    const outer = i % 2 === 0;
    const [x, y] = onCircle(12, 12, outer ? 9.75 : 8.25, i * 15 - 90);
    return [x, y, outer ? 1.6 : 0.9];
  });

/** Verified: a scalloped seal with a check, cut out of it when solid. */
export const SealCheckIcon = /* @__PURE__ */ glyph("SealCheck", () => [
  shape(polygon(scallops())),
  detail(
    polyline([
      [8.25, 12.25],
      [10.75, 14.75, 0.8],
      [15.75, 9.5],
    ]),
  ),
]);
