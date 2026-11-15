import { glyph } from "../glyph.ts";
import { lockBody, shackleOpen } from "./lock-simple.ts";

/** Not secure: a plain padlock, open. */
export const LockSimpleOpenIcon = /* @__PURE__ */ glyph("LockSimpleOpen", () => [
  lockBody(),
  shackleOpen(),
]);
