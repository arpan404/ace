import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Usage: three bars of different heights. */
export const ChartBarIcon = /* @__PURE__ */ glyph("ChartBar", () => [
  shape(rect(3.75, 12, 3.5, 8.5, 1.5)),
  shape(rect(10.25, 3.5, 3.5, 17, 1.5)),
  shape(rect(16.75, 8, 3.5, 12.5, 1.5)),
]);
