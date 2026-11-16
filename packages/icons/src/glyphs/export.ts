import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { arrow } from "./arrow-up.ts";

/** Export, or share out: an arrow rising out of an open box. */
export const ExportIcon = /* @__PURE__ */ glyph("Export", () => [
  ...arrow([12, 14.5], [12, 3.5]),
  line(
    polyline([
      [8.75, 9.5],
      [4.75, 9.5, 2.75],
      [4.75, 20.5, 2.75],
      [19.25, 20.5, 2.75],
      [19.25, 9.5, 2.75],
      [15.25, 9.5],
    ]),
  ),
]);
