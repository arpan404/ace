import { WarningCircleIcon } from "@ace/icons";
import { pinnedGlyph } from "./icon.tsx";

/**
 * Empty states' glyphs, drawn two-tone (`duotone`), the only place that weight is used. An empty
 * state's glyph is added here.
 */
export const emptyGlyphs = {
  warning: pinnedGlyph(WarningCircleIcon, ["duotone"]),
};
