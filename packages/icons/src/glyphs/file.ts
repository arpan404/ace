import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape, type Part } from "../parts.ts";

/** A page with a turned corner; also the base of every file type, which adds one mark inside. */
export const page = (): Part[] => [
  shape(
    polygon([
      [5, 2.5, 4],
      [13, 2.5, 0.8],
      [19, 8.5, 0.8],
      [19, 21.5, 4],
      [5, 21.5, 4],
    ]),
  ),
  detail("M13 2.9V6.5a2 2 0 0 0 2 2h3.6"),
];

/** A file: a page with a turned corner. */
export const FileIcon = /* @__PURE__ */ glyph("File", page);
