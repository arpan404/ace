import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { shape } from "../parts.ts";
import { arrow } from "./arrow-up.ts";

/** Restore: an arrow rising out of the inbox tray. */
export const TrayArrowUpIcon = /* @__PURE__ */ glyph("TrayArrowUp", () => [
  ...arrow([12, 12.25], [12, 3]),
  shape(
    polygon([
      [3, 12.5, 0.8],
      [7.75, 12.5, 1.2],
      [9.25, 15.25, 1.6],
      [14.75, 15.25, 1.6],
      [16.25, 12.5, 1.2],
      [21, 12.5, 0.8],
      [21, 20.5, 4],
      [3, 20.5, 4],
    ]),
  ),
]);
