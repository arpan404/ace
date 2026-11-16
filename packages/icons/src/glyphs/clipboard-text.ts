import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** Paste, or a summary: a clipboard holding lines of text. */
export const ClipboardTextIcon = /* @__PURE__ */ glyph("ClipboardText", () => [
  {
    ...shape(rect(4.5, 4.5, 15, 17, 3.5)),
    gap: { path: "M9.75 4.5h4.5", width: 3.5 },
  },
  shape(rect(8.5, 2.75, 7, 3.5, 1.5)),
  detail("M8.5 11.5h7M8.5 15.5h4.5"),
]);
