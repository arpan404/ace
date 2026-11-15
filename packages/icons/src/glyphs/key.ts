import { glyph } from "../glyph.ts";
import { circle, line, shape, spot } from "../parts.ts";

/** A key: a round bow and a toothed blade. */
export const KeyIcon = /* @__PURE__ */ glyph("Key", () => [
  shape(circle(8.5, 8.5, 5.75)),
  spot(circle(7.25, 7.25, 1.5)),
  line("M12.6 12.6 20.75 20.75M16.25 16.25 13.75 18.75M19 19l-2.25 2.25"),
]);
