import { glyph } from "../glyph.ts";
import { slashed } from "../parts.ts";
import { shieldBody } from "./shield.ts";

/** Kept out, unprotected: the shield, crossed out. */
export const ShieldSlashIcon = /* @__PURE__ */ glyph("ShieldSlash", () => slashed([shieldBody()]));
