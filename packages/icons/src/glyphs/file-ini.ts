import { glyph } from "../glyph.ts";
import { configMark, fileWith } from "./file-marks.ts";

/** A config or env file: a page with two sliders. */
export const FileIniIcon = /* @__PURE__ */ glyph("FileIni", () => fileWith(configMark()));
