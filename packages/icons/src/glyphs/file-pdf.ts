import { glyph } from "../glyph.ts";
import { layoutMark, fileWith } from "./file-marks.ts";

/** A PDF: a page laid out, a picture over lines. */
export const FilePdfIcon = /* @__PURE__ */ glyph("FilePdf", () => fileWith(layoutMark()));
