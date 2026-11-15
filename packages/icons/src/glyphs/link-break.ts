import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { linkHalf } from "./link.ts";

/** Unlink: the two halves of a chain pulled apart, with a spark on each side of the break. */
export const LinkBreakIcon = /* @__PURE__ */ glyph("LinkBreak", () => [
  linkHalf(-1, 2.5),
  linkHalf(1, 2.5),
  line("M7.5 7.5 5.75 5.75M16.5 16.5l1.75 1.75"),
]);
