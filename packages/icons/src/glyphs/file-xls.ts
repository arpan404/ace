import { glyph } from "../glyph.ts";
import { tableMark, fileWith } from "./file-marks.ts";

/** A spreadsheet: a page with a grid. */
export const FileXlsIcon = /* @__PURE__ */ glyph("FileXls", () => fileWith(tableMark()));
