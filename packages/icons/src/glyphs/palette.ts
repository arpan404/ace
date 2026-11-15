import { glyph } from "../glyph.ts";
import { dot, shape } from "../parts.ts";

/** Appearance: a painter's palette with four colours. */
export const PaletteIcon = /* @__PURE__ */ glyph("Palette", () => [
  shape(
    "M12 3a9 9 0 0 0 0 18c1.25 0 2-.85 2-1.9 0-1.4-1.15-1.85-1.15-3.1 0-1.05.85-1.75 1.95-1.75h2.1c2.4 0 4.1-1.7 4.1-4.1C21 6.2 17 3 12 3Z",
  ),
  dot(7.5, 12, 1.3),
  dot(8.75, 7.75, 1.3),
  dot(12.75, 6.5, 1.3),
  dot(16.5, 8.75, 1.3),
]);
