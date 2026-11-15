import { glyph } from "../glyph.ts";
import { markdownMark, fileWith } from "./file-marks.ts";

/** Markdown: a page with a heading's hash. */
export const FileMdIcon = /* @__PURE__ */ glyph("FileMd", () => fileWith(markdownMark()));
