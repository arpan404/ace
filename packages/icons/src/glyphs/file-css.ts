import { glyph } from "../glyph.ts";
import { styleMark, fileWith } from "./file-marks.ts";

/** A stylesheet: a page with curly braces. */
export const FileCssIcon = /* @__PURE__ */ glyph("FileCss", () => fileWith(styleMark()));
