import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { shape } from "../parts.ts";

/** A headset: one wide visor with a notch for the nose. */
export const GogglesIcon = /* @__PURE__ */ glyph("Goggles", () => [
  shape(
    polygon([
      [2.5, 6.75, 4.5],
      [21.5, 6.75, 4.5],
      [21.5, 17.25, 4],
      [15.25, 17.25, 1.5],
      [13.25, 14.5, 1.5],
      [10.75, 14.5, 1.5],
      [8.75, 17.25, 1.5],
      [2.5, 17.25, 4],
    ]),
  ),
]);
