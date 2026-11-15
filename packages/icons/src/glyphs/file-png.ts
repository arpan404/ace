import { glyph } from "../glyph.ts";
import { imageMark, fileWith } from "./file-marks.ts";

/** A PNG image: a page with a hill under a sun. */
export const FilePngIcon = /* @__PURE__ */ glyph("FilePng", () => fileWith(imageMark()));
