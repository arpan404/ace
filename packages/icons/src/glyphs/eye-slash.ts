import { glyph } from "../glyph.ts";
import { slashed } from "../parts.ts";
import { eye } from "./eye.ts";

/** Hide: the eye, crossed out. */
export const EyeSlashIcon = /* @__PURE__ */ glyph("EyeSlash", () => slashed(eye()));
