import { glyph } from "../glyph.ts";
import { circle, detail, shape } from "../parts.ts";

/** The web: a globe with one meridian and the equator. */
export const GlobeIcon = /* @__PURE__ */ glyph("Globe", () => [
  shape(circle(12, 12, 9.25)),
  detail(
    "M12 2.9c-2.4 2.5-3.75 5.6-3.75 9.1s1.35 6.6 3.75 9.1c2.4-2.5 3.75-5.6 3.75-9.1S14.4 5.4 12 2.9Z",
  ),
  detail("M3.2 12h17.6"),
]);
