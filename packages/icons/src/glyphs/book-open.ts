import { glyph } from "../glyph.ts";
import { detail, shape } from "../parts.ts";

/** A skill: an open book. */
export const BookOpenIcon = /* @__PURE__ */ glyph("BookOpen", () => [
  shape(
    "M12 6.75C10 5 7 4.4 3 4.75v13.75c4-.35 7 .25 9 2 2-1.75 5-2.35 9-2V4.75C17 4.4 14 5 12 6.75Z",
  ),
  detail("M12 7v13"),
]);
