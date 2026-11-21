import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** A torch: a wide head over a narrow handle, with its switch. */
export const FlashlightIcon = /* @__PURE__ */ glyph("Flashlight", () => [
  shape(
    polygon([
      [6, 2.5, 2],
      [18, 2.5, 2],
      [18, 6.5, 1],
      [15, 10.5, 1],
      [15, 21.5, 2.5],
      [9, 21.5, 2.5],
      [9, 10.5, 1],
      [6, 6.5, 1],
    ]),
  ),
  detail("M6.5 6.5h11"),
  detail("M12 14v3"),
]);
