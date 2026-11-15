import { glyph } from "../glyph.ts";
import { bubble } from "../geometry.ts";
import { shape, type Part } from "../parts.ts";

/** The round bubble with its short tail; the base every chat icon builds on. */
export const chatCircle = (): Part[] => [shape(bubble(12, 11.25, 8.75))];

/** A conversation: a round bubble with a short tail. */
export const ChatCircleIcon = /* @__PURE__ */ glyph("ChatCircle", chatCircle);
