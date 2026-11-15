import { glyph } from "../glyph.ts";
import { circle, detail, shape, type Part } from "../parts.ts";

/** A person in a ring; the base of the reviewer marks. */
export const userCircle = (): Part[] => [
  shape(circle(12, 12, 9.25)),
  detail(circle(12, 9.75, 3.1)),
  detail("M6.55 19.4c1.2-2.5 3.15-3.65 5.45-3.65s4.25 1.15 5.45 3.65"),
];

/** A profile: a person in a ring. */
export const UserCircleIcon = /* @__PURE__ */ glyph("UserCircle", userCircle);
