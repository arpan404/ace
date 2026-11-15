import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Play: a soft triangle pointing right, the same size as Stop's square. */
export const PlayIcon = /* @__PURE__ */ glyph("Play", () => [
  shape(
    polygon([
      [7.75, 4.75, 2.25],
      [19.5, 12, 2.25],
      [7.75, 19.25, 2.25],
    ]),
  ),
]);
