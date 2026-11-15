import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Pin: a push pin. */
export const PushPinIcon = /* @__PURE__ */ glyph("PushPin", () => [
  shape(
    polygon([
      [8, 3, 1.6],
      [16, 3, 1.6],
      [15, 9, 0.6],
      [18.5, 14, 1.6],
      [5.5, 14, 1.6],
      [9, 9, 0.6],
    ]),
  ),
  line("M12 14v7"),
]);
