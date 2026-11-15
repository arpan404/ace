import { glyph } from "../glyph.ts";
import { onCircle, polyline } from "../geometry.ts";
import { detail } from "../parts.ts";
import { ring } from "./circle.ts";

/** Clear, or not allowed: a circle with a bar across it. */
export const ProhibitIcon = /* @__PURE__ */ glyph("Prohibit", () => [
  ring(),
  detail(polyline([onCircle(12, 12, 8.4, 225), onCircle(12, 12, 8.4, 45)])),
]);
