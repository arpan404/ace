import { glyph } from "../glyph.ts";
import { spot } from "../parts.ts";
import { ring } from "./circle.ts";

/** In progress: a circle with its right half filled. */
export const CircleHalfIcon = /* @__PURE__ */ glyph("CircleHalf", () => [
  ring(),
  spot("M12 6.25a5.75 5.75 0 0 1 0 11.5Z"),
]);
