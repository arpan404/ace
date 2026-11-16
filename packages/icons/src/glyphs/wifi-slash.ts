import { glyph } from "../glyph.ts";
import { arc } from "../geometry.ts";
import { dot, line, slashed } from "../parts.ts";

/** Offline: the wifi fan, crossed out. */
export const WifiSlashIcon = /* @__PURE__ */ glyph("WifiSlash", () =>
  slashed([
    line(arc(12, 19.5, 13, -132, -48)),
    line(arc(12, 19.5, 8.5, -132, -48)),
    line(arc(12, 19.5, 4, -132, -48)),
    dot(12, 19, 1.4),
  ]),
);
