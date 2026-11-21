import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape, spot, type Part } from "../parts.ts";

/** One of the code's three finder squares: a rounded frame around a solid centre. */
const finder = (x: number, y: number): Part[] => [
  shape(rect(x, y, 7, 7, 2)),
  spot(rect(x + 2.5, y + 2.5, 2, 2, 0.6)),
];

/** A QR code to scan: three finder squares and a scatter of modules in the fourth corner. */
export const QrCodeIcon = /* @__PURE__ */ glyph("QrCode", () => [
  ...finder(3, 3),
  ...finder(14, 3),
  ...finder(3, 14),
  // Round-capped strokes, so the modules stay solid in every weight.
  line("M15 15h.01M20 15h.01M17.5 17.5h.01M15 20h.01M20 20h.01"),
]);
