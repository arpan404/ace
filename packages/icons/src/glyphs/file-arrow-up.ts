import { glyph } from "../glyph.ts";
import { arrowhead } from "../geometry.ts";
import { detail } from "../parts.ts";
import { page } from "./file.ts";

/** Publish: an arrow rising out of a page. */
export const FileArrowUpIcon = /* @__PURE__ */ glyph("FileArrowUp", () => [
  ...page(),
  detail("M12 17.75V11.5"),
  detail(arrowhead([12, 11.5], -90, 3.75)),
]);
