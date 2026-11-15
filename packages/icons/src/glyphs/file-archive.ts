import { glyph } from "../glyph.ts";
import { archiveMark, fileWith } from "./file-marks.ts";

/** An archive (tar, 7z, rar): a page zipped shut. */
export const FileArchiveIcon = /* @__PURE__ */ glyph("FileArchive", () => fileWith(archiveMark()));
