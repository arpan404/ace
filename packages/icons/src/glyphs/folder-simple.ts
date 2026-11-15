import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** A project: a folder with its tab. */
export const FolderSimpleIcon = /* @__PURE__ */ glyph("FolderSimple", () => [
  shape(
    polygon([
      [2.5, 4.5, 3.5],
      [9.25, 4.5, 2],
      [11.5, 7, 1.5],
      [21.5, 7, 3.5],
      [21.5, 19.5, 4],
      [2.5, 19.5, 4],
    ]),
  ),
  detail("M3 10.75h18"),
]);
