import { glyph } from "../glyph.ts";
import { codeMark, fileWith } from "./file-marks.ts";

/** Rust: a page of code. */
export const FileRsIcon = /* @__PURE__ */ glyph("FileRs", () => fileWith(codeMark()));
