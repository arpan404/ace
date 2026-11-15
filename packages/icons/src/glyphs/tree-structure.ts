import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** An agent tree: a parent and its two children. */
export const TreeStructureIcon = /* @__PURE__ */ glyph("TreeStructure", () => [
  shape(rect(8.5, 3, 7, 5.5, 2)),
  shape(rect(3, 15.5, 7, 5.5, 2)),
  shape(rect(14, 15.5, 7, 5.5, 2)),
  line("M12 8.5V12"),
  line(
    polyline([
      [6.5, 15.5],
      [6.5, 12, 2],
      [17.5, 12, 2],
      [17.5, 15.5],
    ]),
  ),
]);
