import { glyph } from "../glyph.ts";
import { circle, shape, type Part } from "../parts.ts";

/** The plain round ring every in-a-circle status mark is drawn in. */
export const ring = (): Part => shape(circle(12, 12, 9.25));

/** Pending, to do: an empty circle. */
export const CircleIcon = /* @__PURE__ */ glyph("Circle", () => [ring()]);
