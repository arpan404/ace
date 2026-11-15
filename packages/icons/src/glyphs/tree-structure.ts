import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { circle, line, shape } from "../parts.ts";

/** The agent tree: a parent and the two agents it started, joined by soft branches. */
export const TreeStructureIcon = /* @__PURE__ */ glyph("TreeStructure", () => [
  shape(rect(8.5, 2.75, 7, 7, 2.25)),
  line(
    "M12 9.75v1.5c0 1.6-1.3 2.25-3 2.25-1.6 0-3 .9-3 2.6v.15M12 11.25c0 1.6 1.3 2.25 3 2.25 1.6 0 3 .9 3 2.6v.15",
  ),
  shape(circle(6, 18.5, 2.75)),
  shape(circle(18, 18.5, 2.75)),
]);
