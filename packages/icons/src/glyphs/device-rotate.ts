import { glyph } from "../glyph.ts";
import { arc, arrowhead, onCircle, rect } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** Rotate the device: a phone lying on its side, under a turning arrow. */
export const DeviceRotateIcon = /* @__PURE__ */ glyph("DeviceRotate", () => {
  const end = onCircle(12, 13, 8.5, -25);
  return [
    shape(rect(2.5, 12.5, 16, 9, 2.75)),
    detail("M6 15.75v2.5"),
    line(arc(12, 13, 8.5, -155, -25)),
    line(arrowhead(end, 65, 3)),
  ];
});
