import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Unread: a closed envelope. */
export const EnvelopeSimpleIcon = /* @__PURE__ */ glyph("EnvelopeSimple", () => [
  shape(rect(3, 5.25, 18, 13.5, 3.5)),
  detail(
    polyline([
      [6.75, 9.25],
      [12, 13, 1],
      [17.25, 9.25],
    ]),
  ),
]);
