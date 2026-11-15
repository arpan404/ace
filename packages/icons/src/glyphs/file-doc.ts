import { glyph } from "../glyph.ts";
import { documentMark, fileWith } from "./file-marks.ts";

/** A word-processor document: a page with a paragraph mark. */
export const FileDocIcon = /* @__PURE__ */ glyph("FileDoc", () => fileWith(documentMark()));
