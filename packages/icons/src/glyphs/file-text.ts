import { glyph } from "../glyph.ts";
import { textMark, fileWith } from "./file-marks.ts";

/** Text: a page with lines of writing. */
export const FileTextIcon = /* @__PURE__ */ glyph("FileText", () => fileWith(textMark()));
