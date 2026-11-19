import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** A terminal: a window holding a prompt. */
export const TerminalWindowIcon = /* @__PURE__ */ glyph("TerminalWindow", () => [
  shape(rect(2.5, 4, 19, 16, 5)),
  detail(
    polyline([
      [7, 9.5],
      [10, 12, 0.8],
      [7, 14.5],
    ]),
  ),
  detail("M12.5 14.5h4"),
]);
