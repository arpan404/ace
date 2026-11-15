import { glyph } from "../glyph.ts";
import { codeMark, fileWith } from "./file-marks.ts";

/** Code, data or config text with no mark of its own: a page of code. */
export const FileCodeIcon = /* @__PURE__ */ glyph("FileCode", () => fileWith(codeMark()));
