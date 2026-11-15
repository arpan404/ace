import { glyph } from "../glyph.ts";
import { circle, line } from "../parts.ts";

/** Work under way: a dashed ring that stays still. */
export const CircleDashedIcon = /* @__PURE__ */ glyph("CircleDashed", () => [
  line(circle(12, 12, 8.75), { dashed: true }),
]);
