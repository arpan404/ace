import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Its own tab: one browser window over another. */
export const BrowsersIcon = /* @__PURE__ */ glyph("Browsers", () => [
  line(
    polyline([
      [6.5, 17],
      [2.5, 17, 3.5],
      [2.5, 3, 3.5],
      [16.5, 3, 3.5],
      [16.5, 7],
    ]),
  ),
  shape(rect(6.5, 7, 15, 14, 4)),
  detail("M6.9 11.5h14.2"),
]);
