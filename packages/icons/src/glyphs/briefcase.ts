import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Work: a briefcase with its handle. */
export const BriefcaseIcon = /* @__PURE__ */ glyph("Briefcase", () => [
  line(
    polyline([
      [9, 7],
      [9, 3.75, 1.5],
      [15, 3.75, 1.5],
      [15, 7],
    ]),
  ),
  shape(rect(3, 7, 18, 13.25, 3.5)),
  detail("M3.5 12.5h17"),
]);
