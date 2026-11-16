import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { openTray } from "./download-simple.ts";

/** Installed: a check over the open tray that downloads land in. */
export const TrayCheckIcon = /* @__PURE__ */ glyph("TrayCheck", () => [
  line(
    polyline([
      [7.5, 9],
      [10.75, 12.25, 0.8],
      [16.75, 5.75],
    ]),
  ),
  openTray(),
]);
