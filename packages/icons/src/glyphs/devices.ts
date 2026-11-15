import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Many devices: a screen with a phone standing in front of it. */
export const DevicesIcon = /* @__PURE__ */ glyph("Devices", () => [
  line(
    polyline([
      [11, 16],
      [2.5, 16, 3],
      [2.5, 3.5, 3],
      [18.5, 3.5, 3],
      [18.5, 6.5],
    ]),
  ),
  line("M6.5 20.5h4.5"),
  shape(rect(14, 9.5, 7.5, 12, 2.5)),
]);
