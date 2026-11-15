import { glyph } from "../glyph.ts";
import { textMark, fileWith } from "./file-marks.ts";

/** A plain-text file: a page with lines of writing. */
export const FileTxtIcon = /* @__PURE__ */ glyph("FileTxt", () => fileWith(textMark()));
