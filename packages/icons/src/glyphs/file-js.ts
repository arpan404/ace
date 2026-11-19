import { glyph } from "../glyph.ts";
import { codeMark, fileWith } from "./file-marks.ts";

/** JavaScript: a page of code. */
export const FileJsIcon = /* @__PURE__ */ glyph("FileJs", () => fileWith(codeMark()));
