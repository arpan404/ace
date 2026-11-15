import { glyph } from "../glyph.ts";
import { slashed } from "../parts.ts";
import { bell } from "./bell.ts";

/** Notifications off: the bell, crossed out. */
export const BellSlashIcon = /* @__PURE__ */ glyph("BellSlash", () => slashed(bell()));
