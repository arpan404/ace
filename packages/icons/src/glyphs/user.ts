import { glyph } from "../glyph.ts";
import { circle, shape, type Part } from "../parts.ts";

/** Head and shoulders; the base every person icon builds on. */
export const user = (): Part[] => [
  shape(circle(12, 8, 4)),
  shape("M4 20.5c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5Z"),
];

/** A person: head and shoulders. */
export const UserIcon = /* @__PURE__ */ glyph("User", user);
