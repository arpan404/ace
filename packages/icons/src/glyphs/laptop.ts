import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** A laptop: its open screen over a wider base. */
export const LaptopIcon = /* @__PURE__ */ glyph("Laptop", () => [
  shape(rect(4.5, 4.5, 15, 11, 2.75)),
  line("M2.5 19.5h19"),
]);
