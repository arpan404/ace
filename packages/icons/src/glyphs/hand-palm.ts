import { glyph } from "../glyph.ts";
import { detail, shape } from "../parts.ts";

/** Needs your approval: a raised open hand, palm out. */
export const HandPalmIcon = /* @__PURE__ */ glyph("HandPalm", () => [
  shape(
    "M7.1 13V5.55a1.3 1.3 0 0 1 2.6 0V4.3a1.3 1.3 0 0 1 2.6 0v.75a1.3 1.3 0 0 1 2.6 0v2a1.3 1.3 0 0 1 2.6 0v7.45c0 3.9-2.3 6.5-5.25 6.5-2.15 0-3.65-.9-4.85-2.6l-3.25-4.6a1.35 1.35 0 0 1 2.05-1.7Z",
  ),
  detail("M9.7 7v4.5M12.3 6v5.5M14.9 7.75v3.75"),
]);
