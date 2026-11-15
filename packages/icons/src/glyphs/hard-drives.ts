import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, dot, shape } from "../parts.ts";

/** A server: two rack units, each with a light and a slot. */
export const HardDrivesIcon = /* @__PURE__ */ glyph("HardDrives", () => [
  shape(rect(2.75, 3.5, 18.5, 7.5, 2.75)),
  shape(rect(2.75, 13, 18.5, 7.5, 2.75)),
  dot(7, 7.25, 1.2),
  dot(7, 16.75, 1.2),
  detail("M12.5 7.25h4.5M12.5 16.75h4.5"),
]);
