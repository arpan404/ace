import { WarningCircleIcon } from "@phosphor-icons/react";
import { pinnedGlyph } from "./icon.tsx";

/**
 * Empty states' glyphs, drawn in duotone: the only icons the build keeps that weight in
 * (`glyphTables` in `icon-weights.ts`). An empty state's glyph is added here.
 */
export const emptyGlyphs = {
  warning: pinnedGlyph(WarningCircleIcon, ["duotone"]),
};
