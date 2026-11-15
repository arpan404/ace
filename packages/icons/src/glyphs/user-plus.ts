import { glyph } from "../glyph.ts";
import { plussed } from "../parts.ts";
import { user } from "./user.ts";

/** Add someone: the person with a plus. */
export const UserPlusIcon = /* @__PURE__ */ glyph("UserPlus", () => plussed(user()));
