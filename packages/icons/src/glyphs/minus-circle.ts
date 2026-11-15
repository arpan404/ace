import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { ring } from "./circle.ts";

/** No change: a dash in a circle. */
export const MinusCircleIcon = /* @__PURE__ */ glyph("MinusCircle", () => [
  ring(),
  detail("M8 12h8"),
]);
