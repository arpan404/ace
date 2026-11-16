import { glyph } from "../glyph.ts";
import { detail, dot, shape } from "../parts.ts";

/** Add a reaction: a smiling sticker with its lower right corner peeling up. */
export const SmileyStickerIcon = /* @__PURE__ */ glyph("SmileySticker", () => [
  shape("M20.7 15.2A9.25 9.25 0 1 0 15.2 20.7Z"),
  detail("M15.2 20.7c-.4-2.9.6-5.1 5.5-5.5"),
  dot(9, 10, 1.25),
  dot(15, 10, 1.25),
  detail("M8.4 14.1c.8 1.4 1.9 2.15 3.3 2.2"),
]);
