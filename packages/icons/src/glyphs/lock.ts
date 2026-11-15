import { glyph } from "../glyph.ts";
import { detail, type Part } from "../parts.ts";
import { lockBody, shackleShut } from "./lock-simple.ts";

/** The keyhole on the padlock's face. */
export const keyhole = (): Part => detail("M12 14.25v2.75");

/** Locked: a padlock with its keyhole. */
export const LockIcon = /* @__PURE__ */ glyph("Lock", () => [lockBody(), shackleShut(), keyhole()]);
