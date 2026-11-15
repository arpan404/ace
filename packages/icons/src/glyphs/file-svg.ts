import { glyph } from "../glyph.ts";
import { vectorMark, fileWith } from "./file-marks.ts";

/** An SVG: a page with a vector curve. */
export const FileSvgIcon = /* @__PURE__ */ glyph("FileSvg", () => fileWith(vectorMark()));
