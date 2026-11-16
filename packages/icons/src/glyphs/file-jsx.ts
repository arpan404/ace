import { glyph } from "../glyph.ts";
import { markupMark, fileWith } from "./file-marks.ts";

/** A JSX component: a page with a closing tag. */
export const FileJsxIcon = /* @__PURE__ */ glyph("FileJsx", () => fileWith(markupMark()));
