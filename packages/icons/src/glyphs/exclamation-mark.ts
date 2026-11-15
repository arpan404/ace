import { glyph } from "../glyph.ts";
import { circle, line } from "../parts.ts";

/** Needs you: an exclamation mark on its own, its dot drawn as a stroke so every weight keeps it. */
export const ExclamationMarkIcon = /* @__PURE__ */ glyph("ExclamationMark", () => [
  line("M12 4.25v10.5"),
  line(circle(12, 19.25, 0.5)),
]);
