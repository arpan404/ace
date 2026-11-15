import { glyph } from "../glyph.ts";
import { polygon, polyline } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** An open folder: its front tipped forward off the back. */
export const FolderOpenIcon = /* @__PURE__ */ glyph("FolderOpen", () => [
  line(
    polyline([
      [2.5, 18.5],
      [2.5, 4.5, 3.5],
      [9.25, 4.5, 2],
      [11.5, 7, 1.5],
      [16.5, 7, 3],
      [19, 9.5, 3],
      [19, 10.75],
    ]),
  ),
  shape(
    polygon([
      [6.5, 10.75, 2],
      [21.75, 10.75, 1.5],
      [18.75, 19.5, 3],
      [2.5, 19.5, 2],
    ]),
  ),
]);
