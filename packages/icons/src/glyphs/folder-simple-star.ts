import { glyph } from "../glyph.ts";
import { polygon } from "../geometry.ts";
import { detail } from "../parts.ts";
import { starPoints } from "./file-marks.ts";
import { folder } from "./folder-simple.ts";

/** A folder that is already an ace project: the folder with a star on its front. */
export const FolderSimpleStarIcon = /* @__PURE__ */ glyph("FolderSimpleStar", () => [
  ...folder(),
  detail(polygon(starPoints(12, 15.3, 3.8))),
]);
