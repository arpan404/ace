import { glyph } from "../glyph.ts";
import { line, shape } from "../parts.ts";

/** Connected: a plug pushed home into its socket. */
export const PlugsIcon = /* @__PURE__ */ glyph("Plugs", () => [
  line("M5.5 3.25h13"),
  line("M9.25 3.25v4M14.75 3.25v4"),
  shape("M7 7.25h10a.75.75 0 0 1 .75.75v3a5.75 5.75 0 0 1-11.5 0V8a.75.75 0 0 1 .75-.75Z"),
  line("M12 16.75v4.5"),
]);
