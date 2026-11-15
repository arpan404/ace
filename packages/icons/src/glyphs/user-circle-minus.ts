import { glyph } from "../glyph.ts";
import { reviewed } from "./user-circle-marks.ts";

/** A reviewer asked for changes: the person in a ring, with a minus. */
export const UserCircleMinusIcon = /* @__PURE__ */ glyph("UserCircleMinus", () =>
  reviewed("M14.25 18h7.5"),
);
