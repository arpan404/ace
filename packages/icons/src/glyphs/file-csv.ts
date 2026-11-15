import { glyph } from "../glyph.ts";
import { tableMark, fileWith } from "./file-marks.ts";

/** A CSV or TSV table: a page with a grid. */
export const FileCsvIcon = /* @__PURE__ */ glyph("FileCsv", () => fileWith(tableMark()));
