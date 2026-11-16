import { glyph } from "../glyph.ts";
import { slashed } from "../parts.ts";
import { pushPin } from "./push-pin.ts";

/** Unpin: the push pin, crossed out. */
export const PushPinSlashIcon = /* @__PURE__ */ glyph("PushPinSlash", () => slashed(pushPin()));
