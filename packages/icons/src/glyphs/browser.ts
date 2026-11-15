import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** A browser: a window with its address bar across the top. */
export const BrowserIcon = /* @__PURE__ */ glyph("Browser", () => [
  shape(rect(2.5, 4, 19, 16, 5)),
  detail("M2.9 9.25h18.2"),
]);
