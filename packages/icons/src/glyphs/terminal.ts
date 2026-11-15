import { glyph } from "../glyph.ts";
import { polyline } from "../geometry.ts";
import { line } from "../parts.ts";

/** A command: the prompt alone. */
export const TerminalIcon = /* @__PURE__ */ glyph("Terminal", () => [
  line(
    polyline([
      [4.5, 7],
      [9.5, 12, 0.8],
      [4.5, 17],
    ]),
  ),
  line("M12 17.5h7.5"),
]);
