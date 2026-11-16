import { glyph } from "../glyph.ts";
import { lockBody, shackleOpen } from "./lock-simple.ts";
import { keyhole } from "./lock.ts";

/** Unlocked: a padlock with its keyhole, open. */
export const LockOpenIcon = /* @__PURE__ */ glyph("LockOpen", () => [
  lockBody(),
  shackleOpen(),
  keyhole(),
]);
