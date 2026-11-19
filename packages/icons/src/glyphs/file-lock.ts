import { glyph } from "../glyph.ts";
import { lockMark, fileWith } from "./file-marks.ts";

/** A lockfile: a page with a padlock. */
export const FileLockIcon = /* @__PURE__ */ glyph("FileLock", () => fileWith(lockMark()));
