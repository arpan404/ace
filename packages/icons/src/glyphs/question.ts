import { glyph } from "../glyph.ts";
import { circle, detail, dot, shape } from "../parts.ts";

/** A question: a question mark in a circle. */
export const QuestionIcon = /* @__PURE__ */ glyph("Question", () => [
  shape(circle(12, 12, 9.25)),
  detail("M9.6 9.75a2.45 2.45 0 1 1 3.5 2.2c-.7.33-1.1.9-1.1 1.6v.3"),
  dot(12, 16.6, 1.2),
]);
