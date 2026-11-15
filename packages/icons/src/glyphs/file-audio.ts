import { glyph } from "../glyph.ts";
import { audioMark, fileWith } from "./file-marks.ts";

/** An audio file: a page with a music note. */
export const FileAudioIcon = /* @__PURE__ */ glyph("FileAudio", () => fileWith(audioMark()));
