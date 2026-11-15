import { glyph } from "../glyph.ts";
import { bubble } from "../geometry.ts";
import { shape } from "../parts.ts";

/** A conversation: a round bubble with a short tail. */
export const ChatCircleIcon = /* @__PURE__ */ glyph("ChatCircle", () => [
  shape(bubble(12, 11.25, 8.75)),
]);
