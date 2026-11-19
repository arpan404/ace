import { glyph } from "../glyph.ts";
import { markupMark, fileWith } from "./file-marks.ts";

/** A Vue component: a page with a closing tag. */
export const FileVueIcon = /* @__PURE__ */ glyph("FileVue", () => fileWith(markupMark()));
