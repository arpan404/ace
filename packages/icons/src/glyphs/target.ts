import { glyph } from "../glyph.ts";
import { circle, detail, dot, shape } from "../parts.ts";

/** A goal: a target with its bullseye. */
export const TargetIcon = /* @__PURE__ */ glyph("Target", () => [
  shape(circle(12, 12, 9.25)),
  detail(circle(12, 12, 4.75)),
  dot(12, 12, 1.4),
]);
