import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Pause: two soft upright bars, the height of Stop's square. */
export const PauseIcon = /* @__PURE__ */ glyph("Pause", () => [
  shape(rect(5.5, 5.5, 5, 13, 2.25)),
  shape(rect(13.5, 5.5, 5, 13, 2.25)),
]);
