import { glyph } from "../glyph.ts";
import { slashed } from "../parts.ts";
import { image } from "./image.ts";

/** An image that can't be drawn: the picture, crossed out. */
export const ImageBrokenIcon = /* @__PURE__ */ glyph("ImageBroken", () => slashed(image()));
