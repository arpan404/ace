import { glyph } from "../glyph.ts";
import { videoMark, fileWith } from "./file-marks.ts";

/** A video: a page with a play button. */
export const FileVideoIcon = /* @__PURE__ */ glyph("FileVideo", () => fileWith(videoMark()));
