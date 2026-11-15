import { glyph } from "../glyph.ts";
import { codeMark, fileWith } from "./file-marks.ts";

/** C source: a page of code. */
export const FileCIcon = /* @__PURE__ */ glyph("FileC", () => fileWith(codeMark()));
