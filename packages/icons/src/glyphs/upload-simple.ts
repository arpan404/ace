import { glyph } from "../glyph.ts";
import { arrow } from "./arrow-up.ts";
import { openTray } from "./download-simple.ts";

/** Upload, or push: an arrow up out of a tray. */
export const UploadSimpleIcon = /* @__PURE__ */ glyph("UploadSimple", () => [
  ...arrow([12, 15], [12, 3.5]),
  openTray(),
]);
