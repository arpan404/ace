import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** An inbox tray with its scooped front. */
export const TrayIcon = /* @__PURE__ */ glyph("Tray", () => [
  shape(rect(3, 4, 18, 16, 5.5)),
  detail(
    polyline([
      [3.3, 13],
      [8, 13, 1.2],
      [9.5, 15.5, 1.6],
      [14.5, 15.5, 1.6],
      [16, 13, 1.2],
      [20.7, 13],
    ]),
  ),
]);
