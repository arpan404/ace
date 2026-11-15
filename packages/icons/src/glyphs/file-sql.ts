import { glyph } from "../glyph.ts";
import { databaseMark, fileWith } from "./file-marks.ts";

/** SQL: a page with a database. */
export const FileSqlIcon = /* @__PURE__ */ glyph("FileSql", () => fileWith(databaseMark()));
