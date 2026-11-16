import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { detail } from "../parts.ts";
import { shieldBody } from "./shield.ts";

/** Safe, read-only: a shield with a check. */
export const ShieldCheckIcon = /* @__PURE__ */ glyph("ShieldCheck", () => [
  shieldBody(),
  detail(
    polyline([
      [8.75, 11.75],
      [11, 14, 0.8],
      [15.25, 9.5],
    ]),
  ),
]);
