import { glyph } from "../glyph.ts";
import { line, shape } from "../parts.ts";

/** An idea: a light bulb on its base. */
export const LightbulbIcon = /* @__PURE__ */ glyph("Lightbulb", () => [
  shape("M9 16.75c0-2.2-3.5-3.6-3.5-7.5a6.5 6.5 0 0 1 13 0c0 3.9-3.5 5.3-3.5 7.5Z"),
  line("M9.5 19.25h5M10.75 21.5h2.5"),
]);
