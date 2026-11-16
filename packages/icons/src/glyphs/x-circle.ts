import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { ring } from "./circle.ts";

/** Closed, cancelled or an error: a cross in a circle. */
export const XCircleIcon = /* @__PURE__ */ glyph("XCircle", () => [
  ring(),
  detail("M9 9l6 6M15 9l-6 6"),
]);
