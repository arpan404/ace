import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** Language: a script character beside the letter A. */
export const TranslateIcon = /* @__PURE__ */ glyph("Translate", () => [
  line("M3 6.5h9M7.5 3.5v3M5 9.5c1.25 3 3.25 5.25 6.5 6.5M10 9.5c-1 3.25-3 5.75-6.5 7"),
  line(
    polyline([
      [13, 20.5],
      [17, 11, 0.7],
      [21, 20.5],
    ]),
  ),
  line("M14.5 17.25h5"),
]);
