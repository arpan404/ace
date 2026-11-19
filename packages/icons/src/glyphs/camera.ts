import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { circle, detail, shape } from "../parts.ts";

/** A screenshot: a camera body with its lens. */
export const CameraIcon = /* @__PURE__ */ glyph("Camera", () => [
  shape(
    polygon([
      [2.5, 7, 3.5],
      [7, 7, 0.8],
      [8.75, 4, 1.25],
      [15.25, 4, 1.25],
      [17, 7, 0.8],
      [21.5, 7, 3.5],
      [21.5, 20, 3.5],
      [2.5, 20, 3.5],
    ]),
  ),
  detail(circle(12, 13.25, 3.5)),
]);
