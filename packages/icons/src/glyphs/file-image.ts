import { glyph } from "../glyph.ts";
import { imageMark, fileWith } from "./file-marks.ts";

/** An image: a page with a hill under a sun. */
export const FileImageIcon = /* @__PURE__ */ glyph("FileImage", () => fileWith(imageMark()));
