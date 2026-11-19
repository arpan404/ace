import { glyph } from "../glyph.ts";
import { slidesMark, fileWith } from "./file-marks.ts";

/** A slide deck: a page with a pie chart. */
export const FilePptIcon = /* @__PURE__ */ glyph("FilePpt", () => fileWith(slidesMark()));
