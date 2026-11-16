import { glyph } from "../glyph.ts";
import { codeMark, fileWith } from "./file-marks.ts";

/** Python: a page of code. */
export const FilePyIcon = /* @__PURE__ */ glyph("FilePy", () => fileWith(codeMark()));
