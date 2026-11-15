import { glyph } from "../glyph.ts";
import { imageMark, fileWith } from "./file-marks.ts";

/** A JPEG image: a page with a hill under a sun. */
export const FileJpgIcon = /* @__PURE__ */ glyph("FileJpg", () => fileWith(imageMark()));
