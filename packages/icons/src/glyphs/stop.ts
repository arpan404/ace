import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { shape } from "../parts.ts";

/** Stop: a soft square. */
export const StopIcon = /* @__PURE__ */ glyph("Stop", () => [shape(rect(6, 6, 12, 12, 3.5))]);
