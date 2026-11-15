import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line, type Part } from "../parts.ts";
import { arrow } from "./arrow-up.ts";

/** The open tray that downloads land in and uploads leave. */
export const openTray = (): Part =>
  line(
    polyline([
      [3.5, 14.5],
      [3.5, 20, 3.5],
      [20.5, 20, 3.5],
      [20.5, 14.5],
    ]),
  );

/** Download: an arrow down into a tray. */
export const DownloadSimpleIcon = /* @__PURE__ */ glyph("DownloadSimple", () => [
  ...arrow([12, 3.5], [12, 15]),
  openTray(),
]);
