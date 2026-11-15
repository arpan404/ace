import { glyph } from "../glyph.ts";
import { archiveMark, fileWith } from "./file-marks.ts";

/** A zip or gzip archive: a page zipped shut. */
export const FileZipIcon = /* @__PURE__ */ glyph("FileZip", () => fileWith(archiveMark()));
