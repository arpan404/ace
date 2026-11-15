import { glyph } from "../glyph.ts";
import { line, shape } from "../parts.ts";

/** A plugin: a plug with two prongs and its cable. */
export const PlugIcon = /* @__PURE__ */ glyph("Plug", () => [
  line("M9.25 2.75v4.5M14.75 2.75v4.5"),
  shape("M7 7.25h10a.75.75 0 0 1 .75.75v3a5.75 5.75 0 0 1-11.5 0V8a.75.75 0 0 1 .75-.75Z"),
  line("M12 16.75v4.5"),
]);
