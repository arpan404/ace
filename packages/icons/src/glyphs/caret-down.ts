import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Opens downward: a chevron. */
export const CaretDownIcon = /* @__PURE__ */ glyph("CaretDown", () => [
  line(
    polyline([
      [6.5, 9.25],
      [12, 14.75, 0.8],
      [17.5, 9.25],
    ]),
  ),
]);
