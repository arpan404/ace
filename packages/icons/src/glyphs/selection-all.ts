import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { shape } from "../parts.ts";
import { marquee } from "./selection.ts";

/** Select all: the dashed selection around a filled square. */
export const SelectionAllIcon = /* @__PURE__ */ glyph("SelectionAll", () => [
  ...marquee(),
  shape(rect(8.25, 8.25, 7.5, 7.5, 2)),
]);
