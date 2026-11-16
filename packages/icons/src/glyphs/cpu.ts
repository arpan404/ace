import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { detail, line, shape } from "../parts.ts";

/** A chip: a square die with two pins on every side. */
export const CpuIcon = /* @__PURE__ */ glyph("Cpu", () => [
  shape(rect(5.5, 5.5, 13, 13, 3)),
  line("M10 5.5V2.75M14 5.5V2.75M10 18.5v2.75M14 18.5v2.75"),
  line("M5.5 10H2.75M5.5 14H2.75M18.5 10h2.75M18.5 14h2.75"),
  detail(rect(9.5, 9.5, 5, 5, 1.25)),
]);
