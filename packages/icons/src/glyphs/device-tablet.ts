import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape, type Part } from "../parts.ts";

/** A tablet's body, upright; also the base of the Android tablet. */
export const tablet = (): Part[] => [shape(rect(3.75, 2.5, 16.5, 19, 3.25))];

/** An iPad: a tablet with the home bar along the bottom. */
export const DeviceTabletIcon = /* @__PURE__ */ glyph("DeviceTablet", () => [
  ...tablet(),
  detail("M10 18h4"),
]);
