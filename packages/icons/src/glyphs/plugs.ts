import { glyph } from "../glyph.ts";
import { line, shape } from "../parts.ts";

/** A connection: a plug about to meet its socket. */
export const PlugsIcon = /* @__PURE__ */ glyph("Plugs", () => [
  line("M2.5 12h2.25"),
  shape("M10.25 6.75v10.5H9a4.25 4.25 0 0 1-4.25-4.25v-2A4.25 4.25 0 0 1 9 6.75Z"),
  line("M10.25 9.75h2.5M10.25 14.25h2.5"),
  shape("M14.75 6.75H15a4.25 4.25 0 0 1 4.25 4.25v2A4.25 4.25 0 0 1 15 17.25h-.25Z"),
  line("M19.25 12h2.25"),
]);
