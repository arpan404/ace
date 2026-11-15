import { glyph } from "../glyph.ts";
import { markupMark, fileWith } from "./file-marks.ts";

/** A TSX component: a page with a closing tag. */
export const FileTsxIcon = /* @__PURE__ */ glyph("FileTsx", () => fileWith(markupMark()));
