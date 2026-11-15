import { glyph } from "../glyph.ts";
import { sparkle } from "../geometry.ts";
import { shape } from "../parts.ts";

/** A model at work: a four-pointed spark. */
export const SparkleIcon = /* @__PURE__ */ glyph("Sparkle", () => [
  shape(sparkle(12, 12, 9, 0.16)),
]);
