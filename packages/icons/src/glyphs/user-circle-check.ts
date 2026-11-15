import { glyph } from "../glyph.ts";
import { reviewed } from "./user-circle-marks.ts";

/** A reviewer approved: the person in a ring, with a check. */
export const UserCircleCheckIcon = /* @__PURE__ */ glyph("UserCircleCheck", () =>
  reviewed("M14.6 18.1l2.3 2.3 4.5-4.6"),
);
