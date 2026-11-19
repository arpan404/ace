import { glyph } from "../glyph.ts";
import { line, shape } from "../parts.ts";

/** The Marketplace: a shop's scalloped awning over its front, with a door. */
export const StorefrontIcon = /* @__PURE__ */ glyph("Storefront", () => [
  shape(
    "M4.6 4h14.8L21 9a2.25 2.25 0 0 1-4.5 0 2.25 2.25 0 0 1-4.5 0 2.25 2.25 0 0 1-4.5 0A2.25 2.25 0 0 1 3 9z",
  ),
  line("M4.5 12.25V20h15v-7.75"),
  line("M10 20v-4.25h4V20"),
]);
