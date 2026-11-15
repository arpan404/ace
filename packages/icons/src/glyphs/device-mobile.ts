import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape, type Part } from "../parts.ts";

/** A phone's body; also the base of the Android phone. */
export const phone = (): Part[] => [shape(rect(6, 2.5, 12, 19, 3.25))];

/** An iPhone: a phone with the pill at the top of its screen. */
export const DeviceMobileIcon = /* @__PURE__ */ glyph("DeviceMobile", () => [
  ...phone(),
  detail("M10.5 6h3"),
]);
