import { glyph } from "../glyph.ts";
import { circle, line, shape } from "../parts.ts";

/** A team: a person in front of another. */
export const UsersIcon = /* @__PURE__ */ glyph("Users", () => [
  line(circle(16.5, 7.25, 2.9), { hole: circle(9, 8.5, 5.9) }),
  line("M17.25 13.4c2.45.35 4 2.15 4 4.85"),
  shape(circle(9, 8.5, 3.5)),
  shape("M2.75 20.25c0-3.75 2.7-6 6.25-6s6.25 2.25 6.25 6Z"),
]);
