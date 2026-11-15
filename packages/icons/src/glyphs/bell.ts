import { glyph } from "../glyph.ts";
import { line, shape } from "../parts.ts";

/** Notifications: a bell and its clapper. */
export const BellIcon = /* @__PURE__ */ glyph("Bell", () => [
  shape(
    "M4.75 17h14.5l-1.25-2.1a2.6 2.6 0 0 1-.36-1.33V10.5a5.64 5.64 0 0 0-11.28 0v3.07a2.6 2.6 0 0 1-.36 1.33Z",
  ),
  line("M9.75 20.25a2.6 2.6 0 0 0 4.5 0"),
]);
