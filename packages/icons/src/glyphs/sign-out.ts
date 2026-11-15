import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";
import { arrow } from "./arrow-up.ts";

/** Disconnect: an arrow leaving through a doorway. */
export const SignOutIcon = /* @__PURE__ */ glyph("SignOut", () => [
  line(
    polyline([
      [10, 4],
      [4.5, 4, 3.5],
      [4.5, 20, 3.5],
      [10, 20],
    ]),
  ),
  ...arrow([9.5, 12], [20.5, 12]),
]);
