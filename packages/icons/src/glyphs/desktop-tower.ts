import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** A desktop computer: a tall tower case with two bays and its power light. */
export const DesktopTowerIcon = /* @__PURE__ */ glyph("DesktopTower", () => [
  shape(rect(6, 2.5, 12, 19, 3.5)),
  detail("M9.5 7h5M9.5 10.5h5"),
  dot(12, 17, 1.2),
]);
