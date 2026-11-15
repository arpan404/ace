import { glyph } from "../glyph.ts";
import { circle, shape } from "../parts.ts";

/** Record: a round button, the same weight as Stop's square. */
export const RecordIcon = /* @__PURE__ */ glyph("Record", () => [shape(circle(12, 12, 6.75))]);
