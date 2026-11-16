import { glyph } from "../glyph.ts";
import { detail, dot } from "../parts.ts";
import { shieldBody } from "./shield.ts";

/** Asks first: a shield with an exclamation. */
export const ShieldWarningIcon = /* @__PURE__ */ glyph("ShieldWarning", () => [
  shieldBody(),
  detail("M12 7.75v4.5"),
  dot(12, 15.4, 1.2),
]);
