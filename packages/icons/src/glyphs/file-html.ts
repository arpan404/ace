import { glyph } from "../glyph.ts";
import { markupMark, fileWith } from "./file-marks.ts";

/** HTML: a page with a closing tag. */
export const FileHtmlIcon = /* @__PURE__ */ glyph("FileHtml", () => fileWith(markupMark()));
