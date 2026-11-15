import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { dot, shape } from "../parts.ts";

/** An app: a window with its three title-bar dots. */
export const AppWindowIcon = /* @__PURE__ */ glyph("AppWindow", () => [
  shape(rect(2.5, 4, 19, 16, 5)),
  dot(7, 8.75, 1.15),
  dot(10.5, 8.75, 1.15),
  dot(14, 8.75, 1.15),
]);
