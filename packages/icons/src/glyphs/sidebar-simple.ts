import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, shape } from "../parts.ts";

/** The sidebar: a window with its side pane. */
export const SidebarSimpleIcon = /* @__PURE__ */ glyph("SidebarSimple", () => [
  shape(rect(2.5, 4, 19, 16, 5)),
  detail("M9.5 4.6v14.8"),
]);
